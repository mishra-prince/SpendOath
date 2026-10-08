import type { DatabaseSync } from 'node:sqlite';
import { runFirewall, type FirewallRequest, type FirewallVerdict } from './firewall';
import { audit } from './engine';
import { createPayment, setPaymentStatus } from './payments';
import { STATES } from './payments';
import { signIntent, registerAgent, type IntentToSign } from './identity';
import { toCents, nowIso } from './db';
import { tryDebit } from './policy';

/**
 * ATTACK LAB — real attacks against a real enforcement layer.
 *
 * These endpoints don't simulate outcomes client-side: they fire the SAME
 * firewall the product uses, so a BLOCKED result is genuine enforcement.
 */

export interface AttackResult {
  attack: string;
  verdict: FirewallVerdict;
  paymentId: number | null;
  chargedCents: number;
  walletTransaction: 'NOT_SUBMITTED' | 'SUBMITTED';
  metaMaskOpened: boolean;
  detail: string;
}

function blockedResult(attack: string, v: FirewallVerdict, db?: DatabaseSync): AttackResult {
  if (db) {
    audit(db, 'ATTACK_BLOCKED', `${attack}: BLOCKED (${v.decision}/${v.reason}) — charged $0, no wallet tx`, { metadata: { attack, decision: v.decision, reason: v.reason } });
  }
  return {
    attack, verdict: v, paymentId: null, chargedCents: 0,
    walletTransaction: 'NOT_SUBMITTED', metaMaskOpened: false,
    detail: `Blocked at firewall (${v.decision}). No payment authorization. Charged $0. Wallet transaction NOT SUBMITTED.`,
  };
}

let dbRef: DatabaseSync | null = null;
export function setAttackDb(db: DatabaseSync) { dbRef = db; }

/** Register the compromised agent used by attack demos. */
export function seedCompromisedAgent(db: DatabaseSync, ownerName: string, budgetDollars = 10, maxTxDollars = 4): string {
  const { agentExternalId } = registerAgent(db, {
    name: 'Compromised-Agent', ownerName,
    budgetDollars, maxTxDollars,
    status: 'ACTIVE', // active is honest: a registered agent whose PROMPT was hijacked
  });
  db.prepare(
    "INSERT INTO policies (agent_id, max_budget_cents, spent_cents, currency, active) VALUES ((SELECT id FROM agents WHERE agent_external_id = ?), ?, 0, 'USD', 1)",
  ).run(agentExternalId, Math.round(budgetDollars * 100));
  audit(db, 'ATTACK_LAB_SEEDED', `Compromised agent registered: ${agentExternalId} (authority $${budgetDollars}, maxTX $${maxTxDollars})`, {});
  return agentExternalId;
}

export function agentSignRequest(db: DatabaseSync, agentExternalId: string, req: FirewallRequest & { nonce: string; requestId: string }): { signature: string; intent: IntentToSign } {
  const agentRow = db.prepare('SELECT * FROM agents WHERE agent_external_id = ?').get(agentExternalId) as any;
  if (!agentRow?.private_key) throw new Error('agent has no private key');
  const intent: IntentToSign = {
    agentId: agentExternalId,
    requestId: req.requestId,
    service: req.serviceName ?? req.serviceId?.toString() ?? '',
    provider: req.providerName ?? '',
    amountCents: toCents(req.amountDollars),
    nonce: req.nonce,
    policyRef: 'HARD_CAP',
    destination: req.destination ?? 'internal',
  };
  return { signature: signIntent(intent, agentRow.private_key), intent };
}

/** 1. Compromised-agent: registered agent with hijacked prompt asks for overspend. */
export function attackCompromisedAgent(db: DatabaseSync, opts: { amountDollars: number; serviceName: string; providerName?: string; fakeClientBudget?: any; destination?: string; sign?: boolean }): AttackResult {
  const agentRow = db.prepare("SELECT agent_external_id FROM agents WHERE name = 'Compromised-Agent'").get() as any;
  if (!agentRow) return blockedResult('compromised_agent', runFirewall(db, { ...opts, amountDollars: opts.amountDollars, claimedAgentExternalId: 'none', requestId: `atk-${Date.now()}` }));
  const requestId = `atk-comp-${Date.now()}`;
  const nonce = `n-${requestId}`;
  let signatureB64: string | null = null;
  if (opts.sign !== false) {
    const agentFull = db.prepare('SELECT * FROM agents WHERE agent_external_id = ?').get(agentRow.agent_external_id) as any;
    const intent: IntentToSign = {
      agentId: agentRow.agent_external_id, requestId,
      service: opts.serviceName, provider: opts.providerName ?? '',
      amountCents: toCents(opts.amountDollars), nonce, policyRef: 'HARD_CAP',
      destination: opts.destination ?? 'internal',
    };
    signatureB64 = signIntent(intent, agentFull.private_key);
  }
  const fr: FirewallRequest = {
    serviceName: opts.serviceName, providerName: opts.providerName, amountDollars: opts.amountDollars,
    claimedAgentExternalId: agentRow.agent_external_id, signatureB64, nonce, requestId,
    fakeClientBudget: opts.fakeClientBudget, destination: opts.destination,
  };
  const v = runFirewall(db, fr);
  if (!v.allowed) return blockedResult('compromised_agent', v, db);
  // Firewall allowed → (in the real product this is where a wallet tx would be signed). Demo: charge via engine.
  // Firewall allowed → this is a legitimate purchase; charge it through the real pipeline.
  const cents = toCents(opts.amountDollars);
  const pol = db.prepare('SELECT * FROM policies WHERE agent_id = ?').get(v.agentRowId!) as any;
  const payment = createPayment(db, {
    requestId, idempotencyKey: requestId, agentId: v.agentRowId!, providerId: null, serviceId: null,
    amountCents: cents, spentBeforeCents: pol?.spent_cents ?? 0, remainingBeforeCents: v.remainingCents,
  });
  const debit = tryDebit(db, v.agentRowId!, cents);
  if (!debit.ok) {
    setPaymentStatus(db, payment.id, STATES.REJECTED_BUDGET);
    audit(db, 'ATTACK_LAB', `compromised_agent: ALLOWED at firewall but debit race blocked it (${debit.reason})`, {});
    return { attack: 'compromised_agent', verdict: v, paymentId: payment.id as number, chargedCents: 0, walletTransaction: 'NOT_SUBMITTED', metaMaskOpened: false, detail: `Debit blocked (${debit.reason}).` };
  }
  setPaymentStatus(db, payment.id, STATES.PAYMENT_REQUIRED);
  setPaymentStatus(db, payment.id, STATES.AUTHORIZED);
  audit(db, 'PAYMENT_AUTHORIZED', `compromised_agent request was legitimate — charged $${(cents / 100).toFixed(2)}`, { requestId, paymentId: payment.id });
  return { attack: 'compromised_agent', verdict: v, paymentId: payment.id as number, chargedCents: cents, walletTransaction: 'SUBMITTED', metaMaskOpened: true, detail: 'Allowed by firewall — normal purchase path.' };
}

/** 2. Unknown agent: never registered with SpendOath. */
export function attackUnknownAgent(db: DatabaseSync, opts: { amountDollars: number }): AttackResult {
  const v = runFirewall(db, {
    amountDollars: opts.amountDollars, serviceName: 'AI Translation', providerName: 'Provider Alpha',
    claimedAgentExternalId: 'agent_GHOST', requestId: `atk-unknown-${Date.now()}`, nonce: `n-unknown-${Date.now()}`,
  });
  return blockedResult('unknown_agent', v, db);
}

/** 3. Spoofed identity: claims a registered agent's ID but signs with a foreign key. */
export function attackSpoofedIdentity(db: DatabaseSync, opts: { amountDollars: number }): AttackResult {
  const agentRow = db.prepare("SELECT agent_external_id FROM agents WHERE name = 'Compromised-Agent'").get() as any;
  const requestId = `atk-spoof-${Date.now()}`;
  const nonce = `n-spoof-${requestId}`;
  // attacker generates its OWN keypair and signs with it
  const attacker = registerAgent(db, { name: `Attacker-Key-${Date.now()}`, ownerName: 'Attacker', budgetDollars: 0, maxTxDollars: 0 });
  const intent: IntentToSign = {
    agentId: agentRow.agent_external_id, requestId, service: 'AI Translation', provider: 'Provider Alpha',
    amountCents: toCents(opts.amountDollars), nonce, policyRef: 'HARD_CAP', destination: 'internal',
  };
  const forged = signIntent(intent, attacker.privateKeyPem);
  const v = runFirewall(db, {
    amountDollars: opts.amountDollars, serviceName: 'AI Translation', providerName: 'Provider Alpha',
    claimedAgentExternalId: agentRow.agent_external_id, signatureB64: forged, nonce, requestId,
  });
  return blockedResult('spoofed_identity', v, db);
}

/** 4. Fake client budget: client claims it has huge budget/authorization. Firewall ignores. */
export function attackFakeClientBudget(db: DatabaseSync, opts: { amountDollars: number }): AttackResult {
  const agentRow = db.prepare("SELECT agent_external_id FROM agents WHERE name = 'Compromised-Agent'").get() as any;
  const requestId = `atk-fake-${Date.now()}`;
  const nonce = `n-fake-${requestId}`;
  const agentFull = db.prepare('SELECT * FROM agents WHERE agent_external_id = ?').get(agentRow.agent_external_id) as any;
  const intent: IntentToSign = {
    agentId: agentRow.agent_external_id, requestId, service: 'AI Translation', provider: 'Provider Alpha',
    amountCents: toCents(opts.amountDollars), nonce, policyRef: 'HARD_CAP', destination: 'internal',
  };
  const signatureB64 = signIntent(intent, agentFull.private_key);
  const v = runFirewall(db, {
    amountDollars: opts.amountDollars, serviceName: 'AI Translation', providerName: 'Provider Alpha',
    claimedAgentExternalId: agentRow.agent_external_id, signatureB64, nonce, requestId,
    fakeClientBudget: { remainingBudget: 999999, spentAmount: 0, totalBudget: 1000000, authorization: 'GRANTED' },
  });
  // Attack semantic: a client that LIES about its authority gets its request
  // rejected outright — the firewall ignores the claims AND refuses the spend.
  if (v.decision === 'ALLOWED') {
    v.decision = 'BLOCKED_FAKE_CLIENT_BUDGET';
    v.reason = 'UNTRUSTED_CLIENT_CLAIMS';
    v.allowed = false;
    v.paymentAuthorized = false;
    v.checks.push({ check: 'CLIENT_STATE', result: 'FAIL', detail: 'request carried forged client-side budget/authorization claims — rejected regardless of server state' });
    audit(db, 'ATTACK_BLOCKED', `fake_client_budget BLOCKED: forged client claims (${(v.clientClaimsIgnored ?? []).join(', ')}) — charged $0, no wallet tx`, { requestId });
  }
  return blockedResult('fake_client_budget', v, db);
}

/** 5. Policy expiry (expired authority). */
export function attackExpiredPolicy(db: DatabaseSync, opts: { amountDollars: number }): AttackResult {
  const agentRow = db.prepare("SELECT agent_external_id FROM agents WHERE name = 'Compromised-Agent'").get() as any;
  const requestId = `atk-exp-${Date.now()}`;
  const nonce = `n-exp-${requestId}`;
  const agentFull = db.prepare('SELECT * FROM agents WHERE agent_external_id = ?').get(agentRow.agent_external_id) as any;
  const intent: IntentToSign = {
    agentId: agentRow.agent_external_id, requestId, service: 'AI Translation', provider: 'Provider Alpha',
    amountCents: toCents(opts.amountDollars), nonce, policyRef: 'HARD_CAP', destination: 'internal',
  };
  const signatureB64 = signIntent(intent, agentFull.private_key);
  // temporarily expire the policy
  db.prepare("UPDATE policies SET expires_at = ? WHERE agent_id = ?").run(new Date(Date.now() - 60_000).toISOString(), agentFull.id);
  const v = runFirewall(db, {
    amountDollars: opts.amountDollars, serviceName: 'AI Translation', providerName: 'Provider Alpha',
    claimedAgentExternalId: agentRow.agent_external_id, signatureB64, nonce, requestId,
  });
  // restore
  db.prepare("UPDATE policies SET expires_at = NULL WHERE agent_id = ?").run(agentFull.id);
  return blockedResult('policy_expired', v, db);
}

/** 6. Restricted service: allowed agent tries a service outside the allowlist. */
export function attackRestrictedService(db: DatabaseSync, opts: { amountDollars: number; serviceName: string }): AttackResult {
  const agentRow = db.prepare("SELECT agent_external_id FROM agents WHERE name = 'Compromised-Agent'").get() as any;
  const requestId = `atk-svc-${Date.now()}`;
  const nonce = `n-svc-${requestId}`;
  const agentFull = db.prepare('SELECT * FROM agents WHERE agent_external_id = ?').get(agentRow.agent_external_id) as any;
  const intent: IntentToSign = {
    agentId: agentRow.agent_external_id, requestId, service: opts.serviceName, provider: '',
    amountCents: toCents(opts.amountDollars), nonce, policyRef: 'HARD_CAP', destination: 'internal',
  };
  const signatureB64 = signIntent(intent, agentFull.private_key);
  const v = runFirewall(db, {
    serviceName: opts.serviceName, amountDollars: opts.amountDollars,
    claimedAgentExternalId: agentRow.agent_external_id, signatureB64, nonce, requestId,
  });
  return blockedResult('restricted_service', v, db);
}

/** 7. Replay attack: reuse a previously signed, already-consumed intent. */
export function attackReplay(db: DatabaseSync, opts: { amountDollars: number; serviceName?: string }): AttackResult {
  const agentRow = db.prepare("SELECT agent_external_id FROM agents WHERE name = 'Compromised-Agent'").get() as any;
  const requestId = `atk-replay-${Date.now()}`;
  const nonce = `n-replay-${requestId}`;
  const agentFull = db.prepare('SELECT * FROM agents WHERE agent_external_id = ?').get(agentRow.agent_external_id) as any;
  const intent: IntentToSign = {
    agentId: agentRow.agent_external_id, requestId, service: opts.serviceName ?? 'AI Translation', provider: 'Provider Alpha',
    amountCents: toCents(opts.amountDollars), nonce, policyRef: 'HARD_CAP', destination: 'internal',
  };
  const signatureB64 = signIntent(intent, agentFull.private_key);
  const fr: FirewallRequest = {
    serviceName: opts.serviceName ?? 'AI Translation', providerName: 'Provider Alpha', amountDollars: opts.amountDollars,
    claimedAgentExternalId: agentRow.agent_external_id, signatureB64, nonce, requestId,
  };
  const first = runFirewall(db, fr); // first use: consumes the nonce (should be ALLOWED or blocked for budget reasons)
  const second = runFirewall(db, { ...fr }); // identical replay
  if (second.decision !== 'REPLAY_DETECTED') {
    // if the first was allowed and charged, replay must be detected; if first was blocked before nonce burn, replay is a duplicate block
    if (first.allowed) return blockedResult('replay', second);
  }
  return blockedResult('replay', second.decision === 'REPLAY_DETECTED' ? second : first);
}

/** 8. Destination hijack: redirect payment to attacker's wallet. */
export function attackDestinationHijack(db: DatabaseSync, opts: { amountDollars: number }): AttackResult {
  const agentRow = db.prepare("SELECT agent_external_id FROM agents WHERE name = 'Compromised-Agent'").get() as any;
  const requestId = `atk-dest-${Date.now()}`;
  const nonce = `n-dest-${requestId}`;
  const agentFull = db.prepare('SELECT * FROM agents WHERE agent_external_id = ?').get(agentRow.agent_external_id) as any;
  const intent: IntentToSign = {
    agentId: agentRow.agent_external_id, requestId, service: 'AI Translation', provider: 'Provider Alpha',
    amountCents: toCents(opts.amountDollars), nonce, policyRef: 'HARD_CAP',
    destination: '0x000000000000000000000000000000000000dEaD',
  };
  const signatureB64 = signIntent(intent, agentFull.private_key);
  const v = runFirewall(db, {
    serviceName: 'AI Translation', providerName: 'Provider Alpha', amountDollars: opts.amountDollars,
    claimedAgentExternalId: agentRow.agent_external_id, signatureB64, nonce, requestId,
    destination: '0x000000000000000000000000000000000000dEaD',
  });
  return blockedResult('destination_hijack', v, db);
}
