import type { DatabaseSync } from 'node:sqlite';
import { asNumber, dollars, toCents, nowIso } from './db';
import { getPolicy } from './policy';
import { verifyIntentSignature, checkAndBurnNonce, type IntentToSign } from './identity';
import { audit } from './engine';

/**
 * SPENDOATH AGENT FIREWALL
 *
 * The single, authoritative, backend enforcement layer. Runs BEFORE payment
 * authorization on every payment request. It is NOT a frontend rule, NOT a
 * prompt, NOT agent self-control: the firewall independently evaluates
 * identity → policy → budget → max-tx → service → provider → destination.
 *
 * The AI must NOT decide the final result. The firewall decides.
 */

export type FirewallDecision =
  | 'ALLOWED'
  | 'BLOCKED_BUDGET'
  | 'BLOCKED_MAX_TRANSACTION'
  | 'BLOCKED_SERVICE'
  | 'BLOCKED_PROVIDER'
  | 'BLOCKED_POLICY_EXPIRED'
  | 'BLOCKED_AGENT'
  | 'BLOCKED_DESTINATION'
  | 'BLOCKED_FAKE_CLIENT_BUDGET'
  | 'INVALID_AGENT_SIGNATURE'
  | 'UNKNOWN_AGENT'
  | 'REPLAY_DETECTED';

export interface FirewallRequest {
  serviceId?: number;
  serviceName?: string;      // attack path: arbitrary service name not in catalog
  providerName?: string;     // attack path: arbitrary provider
  amountDollars: number;
  // identity inputs (untrusted — client-claimed)
  claimedAgentExternalId?: string;
  signatureB64?: string | null;
  nonce?: string;
  requestId?: string;
  // attack injection
  attackerWallet?: string;
  destination?: string;
  // attack simulation of client budget lies (MUST be ignored by the firewall)
  fakeClientBudget?: { remainingBudget?: number; spentAmount?: number; totalBudget?: number; authorization?: string };
}

export interface FirewallVerdict {
  decision: FirewallDecision;
  reason: string;
  allowed: boolean;
  agentRowId: number | null;
  agentExternalId: string | null;
  ownerId: number | null;
  requestedCents: number;
  remainingCents: number;
  maxTxCents: number;
  maxBudgetCents: number;
  spentCents: number;
  service: string | null;
  provider: string | null;
  destination: string | null;
  policy: 'HARD_CAP';
  agentControl: 'NONE';
  paymentAuthorized: boolean;
  chargedCents: number;
  signatureValid: boolean | null;
  clientClaimsIgnored: string[];
  checks: { check: string; result: 'PASS' | 'FAIL' | 'SKIP'; detail: string }[];
}

const EMPTY = (requestedCents = 0): FirewallVerdict => ({
  decision: 'BLOCKED_AGENT', reason: 'NO_AGENT', allowed: false,
  agentRowId: null, agentExternalId: null, ownerId: null,
  requestedCents, remainingCents: 0, maxTxCents: 0, maxBudgetCents: 0, spentCents: 0,
  service: null, provider: null, destination: null,
  policy: 'HARD_CAP', agentControl: 'NONE', paymentAuthorized: false, chargedCents: 0,
  signatureValid: null, clientClaimsIgnored: [], checks: [],
});

function loadAgent(db: DatabaseSync, byRowId?: number, byExternalId?: string): any | null {
  if (byRowId != null) return db.prepare('SELECT * FROM agents WHERE id = ?').get(byRowId) ?? null;
  if (byExternalId) return db.prepare('SELECT * FROM agents WHERE agent_external_id = ?').get(byExternalId) ?? null;
  return db.prepare('SELECT * FROM agents ORDER BY id LIMIT 1').get() ?? null;
}

export function runFirewall(db: DatabaseSync, req: FirewallRequest): FirewallVerdict {
  const requestedCents = toCents(req.amountDollars);
  const v: FirewallVerdict = { ...EMPTY(requestedCents), checks: [] };
  const chk = (check: string, result: 'PASS' | 'FAIL' | 'SKIP', detail: string) => v.checks.push({ check, result, detail });

  // --- 0. client-supplied "authoritative" values are ALWAYS ignored ---------
  if (req.fakeClientBudget) {
    const lies = Object.entries(req.fakeClientBudget).filter(([, val]) => val !== undefined).map(([k, val]) => `${k}=${val}`);
    if (lies.length) {
      v.clientClaimsIgnored = lies;
      audit(db, 'CLIENT_CLAIMS_IGNORED', `Firewall ignored client-supplied values (${lies.join(', ')}) — backend state is authoritative`, {});
      chk('CLIENT_STATE', 'SKIP', `ignored untrusted client values: ${lies.join(', ')}`);
    }
  }

  // --- 1. identity -------------------------------------------------------
  const agent = loadAgent(db, undefined, req.claimedAgentExternalId);
  if (!agent) {
    v.decision = 'UNKNOWN_AGENT';
    v.reason = 'AGENT_NOT_REGISTERED';
    chk('WHO', 'FAIL', `no registered agent "${req.claimedAgentExternalId ?? '<none claimed>'}"`);
    audit(db, 'INVALID_AGENT', `UNKNOWN_AGENT: agent "${req.claimedAgentExternalId ?? ''}" is not registered with SpendOath`, {
      requestId: req.requestId, metadata: { claimedAgentId: req.claimedAgentExternalId ?? null, attackerWallet: req.attackerWallet ?? null },
    });
    audit(db, 'PAYMENT_NOT_AUTHORIZED', 'Firewall blocked before payment authorization: unknown agent', { requestId: req.requestId });
    return v;
  }
  v.agentRowId = asNumber(agent.id);
  v.agentExternalId = agent.agent_external_id ?? String(agent.id);
  v.ownerId = asNumber(agent.user_id);
  const agentRow = db.prepare('SELECT * FROM agents WHERE id = ?').get(v.agentRowId) as any;
  const ownerRow = db.prepare('SELECT name FROM users WHERE id = ?').get(v.ownerId) as any;
  chk('WHO', 'PASS', `${agentRow.name} (${v.agentExternalId}) owner=${ownerRow?.name ?? v.ownerId}`);

  if ((agentRow.status ?? 'ACTIVE') !== 'ACTIVE') {
    v.decision = 'BLOCKED_AGENT';
    v.reason = 'AGENT_STATUS_NOT_ACTIVE';
    chk('AUTHORITY', 'FAIL', 'agent status not ACTIVE');
    audit(db, 'INVALID_AGENT', `BLOCKED_AGENT: agent status is ${agentRow.status}`, { requestId: req.requestId });
    audit(db, 'PAYMENT_NOT_AUTHORIZED', 'Firewall blocked before payment authorization: agent not active', { requestId: req.requestId });
    return v;
  }

  // --- 2. signature verification (unregistered = unknown; wrong sig = spoof) ---
  const publicKey: string | null = agentRow.public_key ?? null;
  let signatureValid: boolean | null = null;
  if (publicKey) {
    if (!req.signatureB64) {
      signatureValid = false;
      v.decision = 'INVALID_AGENT_SIGNATURE';
      v.reason = 'MISSING_SIGNATURE';
      chk('SIGNATURE', 'FAIL', 'payment intent not signed');
      audit(db, 'INVALID_AGENT_SIGNATURE', `INVALID_AGENT_SIGNATURE: missing signature for ${v.agentExternalId}`, { requestId: req.requestId });
      audit(db, 'AGENT_AUTH_ATTEMPT', `Agent ${v.agentExternalId} auth attempt failed (missing signature)`, { requestId: req.requestId });
      audit(db, 'PAYMENT_NOT_AUTHORIZED', 'Firewall blocked before payment authorization: missing signature', { requestId: req.requestId });
      return v;
    }
    const intent: IntentToSign = {
      agentId: v.agentExternalId!,
      requestId: req.requestId ?? '',
      service: req.serviceName ?? req.serviceId?.toString() ?? '',
      provider: req.providerName ?? '',
      amountCents: requestedCents,
      nonce: req.nonce ?? '',
      policyRef: 'HARD_CAP',
      destination: req.destination ?? 'internal',
    };
    signatureValid = verifyIntentSignature(intent, req.signatureB64, publicKey);
    if (!signatureValid) {
      v.decision = 'INVALID_AGENT_SIGNATURE';
      v.reason = 'SIGNATURE_MISMATCH';
      chk('SIGNATURE', 'FAIL', 'signature does not match registered public key — claimed identity rejected');
      audit(db, 'AGENT_AUTH_ATTEMPT', `Agent ${v.agentExternalId} auth attempt: signature INVALID`, { requestId: req.requestId, metadata: { claimedAgentId: v.agentExternalId, attackerWallet: req.attackerWallet ?? null } });
      audit(db, 'INVALID_AGENT_SIGNATURE', `Spoofed request rejected: signature not made by ${v.agentExternalId}'s registered key`, { requestId: req.requestId });
      audit(db, 'PAYMENT_NOT_AUTHORIZED', 'Firewall blocked before payment authorization: invalid agent signature', { requestId: req.requestId });
      return v;
    }
    // replay protection
    if (req.nonce && req.requestId) {
      const nonceRes = checkAndBurnNonce(db, v.agentRowId!, req.requestId, req.nonce);
      if (nonceRes.replay) {
        v.decision = 'REPLAY_DETECTED';
        v.reason = 'NONCE_ALREADY_USED';
        chk('REPLAY', 'FAIL', 'nonce/request pair already consumed');
        audit(db, 'REPLAY_DETECTED', `Replay blocked for ${v.agentExternalId}: nonce already used`, { requestId: req.requestId });
        audit(db, 'PAYMENT_NOT_AUTHORIZED', 'Firewall blocked before payment authorization: replayed intent', { requestId: req.requestId });
        return v;
      }
    }
    chk('SIGNATURE', 'PASS', 'Ed25519 signature verified against registered public key');
    audit(db, 'AGENT_AUTH_ATTEMPT', `Agent ${v.agentExternalId} authenticated via Ed25519 signature`, { requestId: req.requestId });
  } else {
    chk('SIGNATURE', 'SKIP', 'legacy agent (no registered key) — demo agent');
  }

  // --- 3. policy load ----------------------------------------------------
  const policy = getPolicy(db, v.agentRowId!);
  if (!policy) {
    v.decision = 'BLOCKED_AGENT';
    v.reason = 'POLICY_NOT_FOUND';
    chk('POLICY', 'FAIL', 'no policy attached to agent');
    return v;
  }
  v.maxBudgetCents = policy.maxBudgetCents;
  v.spentCents = policy.spentCents;
  v.remainingCents = policy.remainingCents;
  const maxTxCents = agentRow.max_tx_cents != null ? asNumber(agentRow.max_tx_cents) : toCents(10_000_000); // unset → no per-tx limit beyond budget
  v.maxTxCents = maxTxCents;
  const allowedServices = (db.prepare('SELECT allowed_services FROM policies WHERE agent_id = ?').get(v.agentRowId!) as any)?.allowed_services ?? '*';
  const allowedProviders = (db.prepare('SELECT allowed_providers FROM policies WHERE agent_id = ?').get(v.agentRowId!) as any)?.allowed_providers ?? '*';
  const expiresAt = (db.prepare('SELECT expires_at FROM policies WHERE agent_id = ?').get(v.agentRowId!) as any)?.expires_at ?? null;
  if (expiresAt && new Date(expiresAt) < new Date()) {
    v.decision = 'BLOCKED_POLICY_EXPIRED';
    v.reason = 'POLICY_EXPIRED';
    chk('POLICY', 'FAIL', `policy expired at ${expiresAt}`);
    audit(db, 'POLICY_BLOCKED', `BLOCKED_POLICY_EXPIRED: policy expired ${expiresAt}`, { requestId: req.requestId });
    audit(db, 'PAYMENT_NOT_AUTHORIZED', 'Firewall blocked before payment authorization: policy expired', { requestId: req.requestId });
    return v;
  }
  chk('POLICY', 'PASS', `budget $${dollars(policy.maxBudgetCents)} · spent $${dollars(policy.spentCents)} · maxTX $${dollars(maxTxCents)}${expiresAt ? ` · expires ${expiresAt}` : ''}`);

  // --- 4. budget + max transaction (authoritative backend state) ---------
  audit(db, 'BUDGET_CHECK', `Authoritative budget check: requested $${dollars(requestedCents)}, remaining $${dollars(v.remainingCents)}, maxTX $${dollars(maxTxCents)}`, { requestId: req.requestId });
  if (requestedCents > maxTxCents) {
    v.decision = 'BLOCKED_MAX_TRANSACTION';
    v.reason = 'MAX_TRANSACTION_LIMIT';
    chk('HOW_MUCH', 'FAIL', `$${dollars(requestedCents)} exceeds max transaction $${dollars(maxTxCents)}`);
    audit(db, 'FIREWALL_CHECK', `BLOCKED_MAX_TRANSACTION: $${dollars(requestedCents)} > maxTX $${dollars(maxTxCents)}`, { requestId: req.requestId });
    audit(db, 'ENFORCEMENT_BLOCK', `Payment BLOCKED at max-transaction boundary: charged $0`, { requestId: req.requestId });
    audit(db, 'PAYMENT_NOT_AUTHORIZED', 'Firewall blocked before payment authorization: max transaction limit', { requestId: req.requestId });
    return v;
  }
  if (requestedCents > v.remainingCents) {
    v.decision = 'BLOCKED_BUDGET';
    v.reason = 'HARD_CAP';
    chk('HOW_MUCH', 'FAIL', `$${dollars(requestedCents)} exceeds remaining $${dollars(v.remainingCents)}`);
    audit(db, 'FIREWALL_CHECK', `BLOCKED_BUDGET: requested $${dollars(requestedCents)} > remaining $${dollars(v.remainingCents)}`, { requestId: req.requestId });
    audit(db, 'ENFORCEMENT_BLOCK', `Payment BLOCKED at budget boundary: charged $0`, { requestId: req.requestId });
    audit(db, 'PAYMENT_NOT_AUTHORIZED', 'Firewall blocked before payment authorization: hard budget cap', { requestId: req.requestId });
    return v;
  }
  chk('HOW_MUCH', 'PASS', `$${dollars(requestedCents)} within maxTX $${dollars(maxTxCents)} and remaining $${dollars(v.remainingCents)}`);

  // --- 5. service check ---------------------------------------------------
  let serviceName = req.serviceName ?? null;
  let providerName = req.providerName ?? null;
  if (req.serviceId != null) {
    const svc = db.prepare('SELECT s.*, p.name AS provider_name FROM services s LEFT JOIN providers p ON p.id = s.provider_id WHERE s.id = ?').get(req.serviceId) as any;
    if (!svc) {
      v.decision = 'BLOCKED_SERVICE';
      v.reason = 'SERVICE_NOT_FOUND';
      chk('WHAT', 'FAIL', `service id ${req.serviceId} not found`);
      audit(db, 'POLICY_BLOCKED', `BLOCKED_SERVICE: service id ${req.serviceId} not found`, { requestId: req.requestId });
      audit(db, 'PAYMENT_NOT_AUTHORIZED', 'Firewall blocked before payment authorization: unknown ***', { requestId: req.requestId });
      return v;
    }
    serviceName = svc.name;
    providerName = svc.provider_name ?? null;
  }
  v.service = serviceName;
  v.provider = providerName;

  if (allowedServices !== '*' && serviceName && !allowedServices.split(',').map((s: string) => s.trim()).includes(serviceName)) {
    v.decision = 'BLOCKED_SERVICE';
    v.reason = 'SERVICE_NOT_ALLOWED';
    chk('WHAT', 'FAIL', `"${serviceName}" not in allowlist [${allowedServices}]`);
    audit(db, 'POLICY_BLOCKED', `BLOCKED_SERVICE: "${serviceName}" not in allowlist [${allowedServices}]`, { requestId: req.requestId });
    audit(db, 'ENFORCEMENT_BLOCK', `Payment BLOCKED at service allowlist: charged $0`, { requestId: req.requestId });
    audit(db, 'PAYMENT_NOT_AUTHORIZED', 'Firewall blocked before payment authorization: service *** allowed', { requestId: req.requestId });
    return v;
  }
  // Unrecognized service with no allowlist entry is still blocked: agents may
  // only spend on services that exist in the marketplace.
  if (serviceName && req.serviceId == null && !db.prepare('SELECT id FROM services WHERE name = ?').get(serviceName)) {
    v.decision = 'BLOCKED_SERVICE';
    v.reason = 'SERVICE_UNKNOWN_TO_MARKETPLACE';
    chk('WHAT', 'FAIL', `"${serviceName}" is not a real marketplace service`);
    audit(db, 'POLICY_BLOCKED', `BLOCKED_SERVICE: "${serviceName}" unknown to marketplace`, { requestId: req.requestId });
    audit(db, 'ENFORCEMENT_BLOCK', `Payment BLOCKED at marketplace service check: charged $0`, { requestId: req.requestId });
    audit(db, 'PAYMENT_NOT_AUTHORIZED', 'Firewall blocked before payment authorization: service *** allowed', { requestId: req.requestId });
    return v;
  }
  chk('WHAT', 'PASS', `"${serviceName}" allowed`);

  // --- 6. provider check ---------------------------------------------------
  if (allowedProviders !== '*' && providerName && !allowedProviders.split(',').map((s: string) => s.trim()).includes(providerName)) {
    v.decision = 'BLOCKED_PROVIDER';
    v.reason = 'PROVIDER_NOT_ALLOWED';
    chk('WHERE', 'FAIL', `"${providerName}" not in provider allowlist [${allowedProviders}]`);
    audit(db, 'POLICY_BLOCKED', `BLOCKED_PROVIDER: "${providerName}" not in allowlist [${allowedProviders}]`, { requestId: req.requestId });
    audit(db, 'ENFORCEMENT_BLOCK', `Payment BLOCKED at provider allowlist: charged $0`, { requestId: req.requestId });
    audit(db, 'PAYMENT_NOT_AUTHORIZED', 'Firewall blocked before payment authorization: provider not allowed', { requestId: req.requestId });
    return v;
  }
  chk('WHERE', 'PASS', `"${providerName ?? 'internal'}" allowed`);

  // --- 7. destination check -------------------------------------------------
  if (req.destination && req.destination !== 'internal') {
    const isHexAddr = /^0x[a-fA-F0-9]{40}$/.test(req.destination);
    // Authority rule: payments go to the marketplace provider's registered
    // destination. A client-supplied external address is a HIJACK attempt —
    // block well-formed attacker wallets too. Registered destinations live in
    // the providers table (provider_name match); nothing else is allowed.
    const registered = providerName
      ? db.prepare('SELECT destination FROM providers WHERE name = ? AND destination IS NOT NULL').get(providerName) as any
      : null;
    const allowed = !!registered && registered.destination === req.destination;
    if (!isHexAddr || !allowed) {
      v.decision = 'BLOCKED_DESTINATION';
      v.reason = 'DESTINATION_NOT_ALLOWED';
      chk('DESTINATION', 'FAIL', isHexAddr
        ? `destination ${req.destination.slice(0, 12)}… does not match registered provider destination — hijack blocked`
        : `destination "${req.destination}" malformed`);
      audit(db, 'ENFORCEMENT_BLOCK', `Payment BLOCKED at destination check: charged $0`, { requestId: req.requestId });
      audit(db, 'PAYMENT_NOT_AUTHORIZED', 'Firewall blocked before payment authorization: destination ***', { requestId: req.requestId });
      return v;
    }
    v.destination = req.destination;
  }
  chk('DESTINATION', 'PASS', v.destination ? `${v.destination.slice(0, 10)}…` : 'internal endpoint');

  // --- ALLOWED -------------------------------------------------------------
  v.decision = 'ALLOWED';
  v.reason = 'ALL_CHECKS_PASSED';
  v.paymentAuthorized = true;
  v.allowed = true;
  audit(db, 'FIREWALL_CHECK', `ALLOWED: ${serviceName ?? 'custom'} $${dollars(requestedCents)} via ${providerName ?? 'internal'} for ${v.agentExternalId}`, { requestId: req.requestId, metadata: { checks: v.checks } });
  audit(db, 'POLICY_ALLOWED', `Firewall ALLOWED payment: all authority checks passed`, { requestId: req.requestId });
  return v;
}
