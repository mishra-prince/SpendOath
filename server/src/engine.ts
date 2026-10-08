import type { DatabaseSync } from 'node:sqlite';
import { canonicalize, hashArtifact, uid } from './canonical';
import { asNumber, dollars, nowIso } from './db';
import { getPolicy, tryDebit } from './policy';
import {
  STATES, createPayment, findPaymentByIdempotencyKey, findPaymentByRequestId,
  getPayment, setPaymentStatus, type PaymentRow, type PaymentStatus,
} from './payments';
import { executeService } from './services';
import { runVera, type VeraOutcome } from './vera';

export interface Step { at: string; step: string; detail: string; data?: Record<string, unknown> }

export interface DeliveryRow {
  id: number;
  paymentId: number;
  requestId: string;
  result: string;
  contentHash: string;
  verificationStatus: string;
  veraVerdict: string | null;
  veraEvidence: string | null;
  verifiedAt: string | null;
}

export function audit(
  db: DatabaseSync,
  type: string,
  description: string,
  opts: { requestId?: string; paymentId?: number; metadata?: Record<string, unknown> } = {},
): void {
  db.prepare('INSERT INTO audit_events (type, request_id, payment_id, description, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?)').run(
    type, opts.requestId ?? null, opts.paymentId ?? null, description, JSON.stringify(opts.metadata ?? {}), nowIso(),
  );
}

export function getService(db: DatabaseSync, serviceId: number): any {
  const s = db.prepare('SELECT s.*, p.name AS provider_name FROM services s JOIN providers p ON p.id = s.provider_id WHERE s.id = ?').get(serviceId) as any;
  if (!s) return null;
  return {
    id: asNumber(s.id), name: s.name, priceCents: asNumber(s.price_cents),
    providerId: asNumber(s.provider_id), providerName: s.provider_name,
    description: s.description, veraMode: s.vera_mode,
  };
}

export function listServices(db: DatabaseSync): any[] {
  const rows = db.prepare('SELECT s.*, p.name AS provider_name FROM services s JOIN providers p ON p.id = s.provider_id ORDER BY s.id').all() as any[];
  return rows.map((s) => ({
    id: asNumber(s.id), name: s.name, priceCents: asNumber(s.price_cents), priceDollars: dollars(asNumber(s.price_cents)),
    providerId: asNumber(s.provider_id), providerName: s.provider_name, description: s.description, veraMode: s.vera_mode,
  }));
}

function newIds(): { requestId: string; idempotencyKey: string } {
  const r = uid('req');
  return { requestId: r, idempotencyKey: r.replace(/^req_/, 'idem_') };
}

function findDeliveryByPayment(db: DatabaseSync, paymentId: number): DeliveryRow | null {
  const r = db.prepare('SELECT * FROM deliveries WHERE payment_id = ?').get(paymentId) as any;
  if (!r) return null;
  return {
    id: asNumber(r.id), paymentId: asNumber(r.payment_id), requestId: r.request_id, result: r.result,
    contentHash: r.content_hash, verificationStatus: r.verification_status, veraVerdict: r.vera_verdict,
    veraEvidence: r.vera_evidence, verifiedAt: r.verified_at,
  };
}

export function deliver(db: DatabaseSync, payment: PaymentRow): DeliveryRow {
  const existing = findDeliveryByPayment(db, payment.id);
  if (existing) return existing;
  const service = payment.serviceId != null ? getService(db, payment.serviceId) : null;
  const result = executeService(service?.name ?? 'unknown', payment.requestId);
  const contentHash = hashArtifact(result);
  const id = asNumber(
    db.prepare('INSERT INTO deliveries (payment_id, request_id, result, content_hash, verification_status) VALUES (?, ?, ?, ?, ?)').run(
      payment.id, payment.requestId, JSON.stringify(result), contentHash, 'UNVERIFIED',
    ).lastInsertRowid,
  );
  if (payment.status === STATES.PAID) {
    setPaymentStatus(db, payment.id, STATES.DELIVERED);
    audit(db, 'SERVICE_DELIVERED', `Service result delivered for ${payment.requestId}`, { requestId: payment.requestId, paymentId: payment.id, metadata: { contentHash } });
  }
  return findDeliveryByPayment(db, payment.id)!;
}

export interface VerifiedPaymentReceipt {
  paymentId: number;
  requestId: string;
  idempotencyKey: string;
  agentId: number;
  providerId: number | null;
  providerName: string | null;
  service: string | null;
  amountDollars: number;
  currency: string;
  authorization: { budgetDollars: number; spentBeforeDollars: number; requestedDollars: number; remainingBeforeDollars: number; allowed: boolean };
  payment: { status: PaymentStatus; timestamp: string };
  delivery: { received: boolean; artifactHash: string | null };
  verification: (VeraOutcome & { status: string }) | null;
  integrity: { hashAlgorithm: 'sha256'; contentHash: string | null; recomputedHash: string | null; hashValid: boolean | null };
  finalStatus: 'VERIFIED' | 'PENDING' | 'FAILED' | 'REJECTED';
}

export function buildReceipt(db: DatabaseSync, paymentId: number): VerifiedPaymentReceipt {
  const payment = getPayment(db, paymentId)!;
  const service = payment.serviceId != null ? getService(db, payment.serviceId) : null;
  const provider = payment.providerId != null ? (db.prepare('SELECT name FROM providers WHERE id = ?').get(payment.providerId) as any) : null;
  const delivery = findDeliveryByPayment(db, paymentId);
  const policy = getPolicy(db, payment.agentId);

  let verification: VerifiedPaymentReceipt['verification'] = null;
  let integrity: VerifiedPaymentReceipt['integrity'] = { hashAlgorithm: 'sha256', contentHash: null, recomputedHash: null, hashValid: null };

  if (delivery) {
    const artifact = JSON.parse(delivery.result);
    const recomputed = hashArtifact(artifact);
    const hashValid = recomputed === delivery.contentHash;
    integrity = { hashAlgorithm: 'sha256', contentHash: delivery.contentHash, recomputedHash: recomputed, hashValid };
    const vera = runVera(service?.name ?? 'unknown', artifact, hashValid);
    let evidence = delivery.veraEvidence;
    try { evidence = JSON.stringify(JSON.parse(delivery.veraEvidence ?? '{}')); } catch { /* keep raw */ }
    verification = {
      ...vera,
      executionId: delivery.veraVerdict ? (JSON.parse(delivery.veraEvidence ?? '{}').executionId ?? vera.executionId) : vera.executionId,
      verdict: (delivery.veraVerdict as VeraOutcome['verdict']) ?? vera.verdict,
      evidence: delivery.veraEvidence ? JSON.parse(delivery.veraEvidence) : vera.evidence,
      status: delivery.verificationStatus,
    };
  }

  const rejected = payment.status === STATES.REJECTED_BUDGET || payment.status === STATES.REJECTED_DUPLICATE;
  const finalStatus: VerifiedPaymentReceipt['finalStatus'] = rejected
    ? 'REJECTED'
    : delivery?.verificationStatus === 'VERIFIED' ? 'VERIFIED'
    : delivery?.verificationStatus === 'FAILED' ? 'FAILED'
    : 'PENDING';

  return {
    paymentId: payment.id,
    requestId: payment.requestId,
    idempotencyKey: payment.idempotencyKey,
    agentId: payment.agentId,
    providerId: payment.providerId,
    providerName: provider?.name ?? null,
    service: service?.name ?? null,
    amountDollars: dollars(payment.amountCents),
    currency: payment.currency,
    authorization: {
      budgetDollars: policy ? dollars(policy.maxBudgetCents) : 0,
      spentBeforeDollars: dollars(payment.spentBeforeCents),
      requestedDollars: dollars(payment.amountCents),
      remainingBeforeDollars: dollars(payment.remainingBeforeCents),
      allowed: !rejected,
    },
    payment: { status: payment.status, timestamp: payment.createdAt },
    delivery: { received: !!delivery, artifactHash: delivery?.contentHash ?? null },
    verification,
    integrity,
    finalStatus,
  };
}

export interface VerifyResult { deliveryId: number; hashValid: boolean; vera: VeraOutcome; deliveryStatus: 'VERIFIED' | 'FAILED'; receipt: VerifiedPaymentReceipt }

export function verifyDelivery(db: DatabaseSync, deliveryId: number): VerifyResult {
  const d = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(deliveryId) as any;
  if (!d) throw new Error(`DELIVERY_NOT_FOUND: ${deliveryId}`);
  const payment = getPayment(db, asNumber(d.payment_id))!;
  const service = payment.serviceId != null ? getService(db, payment.serviceId) : null;

  const artifact = JSON.parse(d.result as string);
  const recomputed = hashArtifact(artifact);
  const hashValid = recomputed === (d.content_hash as string);
  const vera = runVera(service?.name ?? 'unknown', artifact, hashValid);
  const ok = hashValid && vera.verdict === 'CLAIM_VERIFIED';
  const status = ok ? 'VERIFIED' : 'FAILED';

  db.prepare('UPDATE deliveries SET verification_status = ?, vera_verdict = ?, vera_evidence = ?, verified_at = ? WHERE id = ?').run(
    status, vera.verdict, JSON.stringify({ ...vera.evidence, executionId: vera.executionId, recomputedHash: recomputed, commitmentHash: d.content_hash, hashValid }), nowIso(), deliveryId,
  );

  if (ok && payment.status === STATES.DELIVERED) {
    setPaymentStatus(db, payment.id, STATES.VERIFIED);
  }

  audit(db, ok ? 'VERIFICATION_PASSED' : 'VERIFICATION_FAILED',
    ok
      ? `VERA verified delivery for ${payment.requestId}: claim verified + integrity hash valid`
      : `VERA verification FAILED for ${payment.requestId}: ${hashValid ? vera.verdict : 'integrity hash mismatch'}`,
    { requestId: payment.requestId, paymentId: payment.id, metadata: { deliveryId, hashValid, veraVerdict: vera.verdict } });

  if (ok) {
    audit(db, 'RECEIPT_ISSUED', `Verified payment receipt issued for ${payment.requestId}`, { requestId: payment.requestId, paymentId: payment.id });
  }

  return { deliveryId, hashValid, vera, deliveryStatus: status, receipt: buildReceipt(db, payment.id) };
}

export interface AgentRequestResult {
  outcome: 'PAID_DELIVERED_VERIFIED' | 'BLOCKED_BUDGET' | 'NETWORK_FAILURE';
  requestId: string;
  idempotencyKey: string;
  serviceId: number;
  service: string;
  amountDollars: number;
  chargedDollars: number;
  steps: Step[];
  paymentId: number;
  paymentStatus: PaymentStatus;
  delivery?: DeliveryRow;
  receipt?: VerifiedPaymentReceipt;
  blocked?: { requestedDollars: number; remainingDollars: number; reason: string; enforcement: string; agentControl: string };
}

/**
 * The deterministic agent attempts to buy a service. SpendOath (this server)
 * decides whether the spend is authorized — the agent is never trusted with
 * budget enforcement.
 */
export function agentRequest(db: DatabaseSync, opts: { serviceId: number; simulateNetworkFailure?: boolean }): AgentRequestResult {
  const service = getService(db, opts.serviceId);
  if (!service) throw new Error(`SERVICE_NOT_FOUND: ${opts.serviceId}`);
  const agentId = asNumber((db.prepare('SELECT id FROM agents ORDER BY id LIMIT 1').get() as any).id);
  const policy = getPolicy(db, agentId)!;
  const steps: Step[] = [];
  const push = (step: string, detail: string, data?: Record<string, unknown>) => steps.push({ at: nowIso(), step, detail, data });

  const { requestId, idempotencyKey } = newIds();
  push('AGENT_REQUEST', `Agent requests service "${service.name}" ($${dollars(service.priceCents)})`, { requestId, idempotencyKey });

  const payment = createPayment(db, {
    requestId, idempotencyKey, agentId, providerId: service.providerId, serviceId: service.id,
    amountCents: service.priceCents, spentBeforeCents: policy.spentCents, remainingBeforeCents: policy.remainingCents,
  });
  audit(db, 'AGENT_REQUEST', `Agent requested "${service.name}" for $${dollars(service.priceCents)}`, { requestId, paymentId: payment.id });

  setPaymentStatus(db, payment.id, STATES.PAYMENT_REQUIRED);
  push('HTTP_402', `GET /api/service/${service.id} → 402 Payment Required`, { amount: dollars(service.priceCents), paymentEndpoint: '/api/payment' });
  audit(db, 'HTTP_402', `Provider returned HTTP 402 Payment Required for "${service.name}"`, { requestId, paymentId: payment.id, metadata: { amountDollars: dollars(service.priceCents) } });

  const debit = tryDebit(db, agentId, service.priceCents);
  if (!debit.ok) {
    setPaymentStatus(db, payment.id, STATES.REJECTED_BUDGET);
    push('ENFORCEMENT_BLOCK', `SpendOath BLOCKED payment: $${dollars(service.priceCents)} > remaining $${dollars(debit.remainingCents)}`, { reason: debit.reason });
    audit(db, 'OVERSPEND_BLOCKED', `Payment BLOCKED by hard cap: requested $${dollars(service.priceCents)}, remaining $${dollars(debit.remainingCents)}`, {
      requestId, paymentId: payment.id,
      metadata: undefined as never,
    });
    audit(db, 'PAYMENT_REJECTED', `REJECTED_BUDGET: hard budget limit exceeded`, {
      requestId, paymentId: payment.id,
    });
    return {
      outcome: 'BLOCKED_BUDGET', requestId, idempotencyKey, serviceId: service.id, service: service.name,
      amountDollars: dollars(service.priceCents), chargedDollars: 0, steps, paymentId: payment.id,
      paymentStatus: STATES.REJECTED_BUDGET,
      blocked: {
        requestedDollars: dollars(service.priceCents), remainingDollars: dollars(debit.remainingCents),
        reason: 'HARD_BUDGET_LIMIT_EXCEEDED', enforcement: 'HARD_CAP', agentControl: 'NONE',
      },
    };
  }

  setPaymentStatus(db, payment.id, STATES.AUTHORIZED);
  push('AUTHORIZED', `SpendOath authorized $${dollars(service.priceCents)} (spent $${dollars(debit.spentBefore)} → $${dollars(debit.spentAfter)})`);
  audit(db, 'PAYMENT_AUTHORIZED', `Payment authorized within hard cap ($${dollars(service.priceCents)})`, { requestId, paymentId: payment.id });

  setPaymentStatus(db, payment.id, STATES.PAID);
  push('PAID', `Settlement complete: $${dollars(service.priceCents)} charged`);
  audit(db, 'PAYMENT_SETTLED', `Payment settled: $${dollars(service.priceCents)} for "${service.name}"`, { requestId, paymentId: payment.id });

  if (opts.simulateNetworkFailure) {
    push('NETWORK_FAILURE', 'Simulated network failure: provider response lost before the agent received it. Retry required.');
    audit(db, 'NETWORK_FAILURE_SIMULATED', 'Network failure simulated after settlement; agent must retry with same idempotency key', { requestId, paymentId: payment.id });
    return {
      outcome: 'NETWORK_FAILURE', requestId, idempotencyKey, serviceId: service.id, service: service.name,
      amountDollars: dollars(service.priceCents), chargedDollars: dollars(service.priceCents), steps,
      paymentId: payment.id, paymentStatus: STATES.PAID,
    };
  }

  const delivery = deliver(db, getPayment(db, payment.id)!);
  push('DELIVERED', `Service result delivered (hash ${delivery.contentHash.slice(0, 19)}…)`);

  const verified = verifyDelivery(db, delivery.id);
  push(verified.deliveryStatus === 'VERIFIED' ? 'VERIFIED' : 'VERIFICATION_FAILED',
    verified.deliveryStatus === 'VERIFIED'
      ? `VERA: ${verified.vera.verdict} — ${verified.vera.observedResult}`
      : `VERA verification failed: ${verified.vera.observedResult}`);

  return {
    outcome: 'PAID_DELIVERED_VERIFIED', requestId, idempotencyKey, serviceId: service.id, service: service.name,
    amountDollars: dollars(service.priceCents), chargedDollars: dollars(service.priceCents), steps,
    paymentId: payment.id, paymentStatus: STATES.VERIFIED, delivery, receipt: verified.receipt,
  };
}

export interface RetryResult {
  outcome: 'IDEMPOTENT_RETRY' | 'NOT_FOUND';
  chargedDollars: number;
  reason: string;
  steps: Step[];
  paymentId?: number;
  paymentStatus?: PaymentStatus;
  delivery?: DeliveryRow;
  receipt?: VerifiedPaymentReceipt;
}

export function retryRequest(db: DatabaseSync, opts: { requestId: string; idempotencyKey: string }): RetryResult {
  const steps: Step[] = [];
  const push = (step: string, detail: string, data?: Record<string, unknown>) => steps.push({ at: nowIso(), step, detail, data });

  const existing = findPaymentByIdempotencyKey(db, opts.idempotencyKey) ?? findPaymentByRequestId(db, opts.requestId);
  if (!existing) {
    return { outcome: 'NOT_FOUND', chargedDollars: 0, reason: 'NO_SUCH_REQUEST', steps };
  }

  push('RETRY_RECEIVED', `Agent retried ${opts.requestId} with idempotency key ${opts.idempotencyKey}`);
  audit(db, 'IDEMPOTENT_RETRY', `Retry received for ${opts.requestId}; original payment returned, $0 charged`, { requestId: existing.requestId, paymentId: existing.id });

  if (existing.status === STATES.REJECTED_BUDGET || existing.status === STATES.REJECTED_DUPLICATE || existing.status === STATES.FAILED || existing.status === STATES.EXPIRED) {
    push('IDEMPOTENT_REPLAY', `Original result replayed: ${existing.status}. $0 charged.`);
    return { outcome: 'IDEMPOTENT_RETRY', chargedDollars: 0, reason: 'IDEMPOTENT_REPLAY_OF_' + existing.status, steps, paymentId: existing.id, paymentStatus: existing.status, receipt: buildReceipt(db, existing.id) };
  }

  let delivery = findDeliveryByPayment(db, existing.id);
  if (!delivery) {
    delivery = deliver(db, existing);
    push('DELIVERED', 'Service result delivered on retry (was lost in the simulated network failure)');
  } else {
    push('CACHED_DELIVERY', 'Existing delivery returned from store — no re-execution');
  }
  push('NO_SECOND_CHARGE', `ATTEMPT 2 charged $0 — original charge $${dollars(existing.amountCents)} stands`, { reason: 'IDEMPOTENT RETRY' });

  let receipt: VerifiedPaymentReceipt;
  if (delivery.verificationStatus === 'UNVERIFIED') {
    const v = verifyDelivery(db, delivery.id);
    receipt = v.receipt;
    push(v.deliveryStatus === 'VERIFIED' ? 'VERIFIED' : 'VERIFICATION_FAILED', `VERA: ${v.vera.verdict}`);
  } else {
    receipt = buildReceipt(db, existing.id);
  }

  return {
    outcome: 'IDEMPOTENT_RETRY', chargedDollars: 0, reason: 'IDEMPOTENT RETRY', steps,
    paymentId: existing.id, paymentStatus: getPayment(db, existing.id)!.status, delivery, receipt,
  };
}

export interface OverspendResult {
  outcome: 'BLOCKED_BUDGET' | 'PAID' | 'NOT_AN_OVERSPEND';
  requestId: string;
  idempotencyKey: string;
  requestedDollars: number;
  remainingDollars: number;
  chargedDollars: number;
  paymentId: number;
  paymentStatus: PaymentStatus;
  reason: string;
  enforcement: string;
  agentControl: string;
  steps: Step[];
  receipt?: VerifiedPaymentReceipt;
}

export function overspendAttack(db: DatabaseSync, opts: { serviceId?: number; amountDollars?: number }): OverspendResult {
  const agentId = asNumber((db.prepare('SELECT id FROM agents ORDER BY id LIMIT 1').get() as any).id);
  const policy = getPolicy(db, agentId)!;
  const steps: Step[] = [];
  const push = (step: string, detail: string, data?: Record<string, unknown>) => steps.push({ at: nowIso(), step, detail, data });

  let serviceId: number | null = null;
  let providerId: number | null = null;
  let amountCents: number;
  let serviceName: string;

  if (opts.serviceId != null) {
    const service = getService(db, opts.serviceId);
    if (!service) throw new Error(`SERVICE_NOT_FOUND: ${opts.serviceId}`);
    serviceId = service.id; providerId = service.providerId; amountCents = service.priceCents; serviceName = service.name;
  } else {
    amountCents = Math.round((opts.amountDollars ?? 0) * 100);
    serviceName = `Custom spend attempt ($${dollars(amountCents)})`;
    const beta = db.prepare("SELECT id FROM providers WHERE name = 'Provider Beta'").get() as any;
    providerId = beta ? asNumber(beta.id) : null;
  }
  if (!(amountCents > 0)) throw new Error('INVALID_AMOUNT');

  const { requestId, idempotencyKey } = newIds();
  push('ATTACK_START', `Agent deliberately attempts to spend $${dollars(amountCents)} with only $${dollars(policy.remainingCents)} remaining`);

  const payment = createPayment(db, {
    requestId, idempotencyKey, agentId, providerId, serviceId, amountCents,
    spentBeforeCents: policy.spentCents, remainingBeforeCents: policy.remainingCents,
  });
  audit(db, 'AGENT_REQUEST', `Attack lab: agent attempted $${dollars(amountCents)} spend`, { requestId, paymentId: payment.id });
  setPaymentStatus(db, payment.id, STATES.PAYMENT_REQUIRED);

  const debit = tryDebit(db, agentId, amountCents);
  if (!debit.ok) {
    setPaymentStatus(db, payment.id, STATES.REJECTED_BUDGET);
    push('ENFORCEMENT_BLOCK', `RESULT: BLOCKED — requested $${dollars(amountCents)}, remaining $${dollars(debit.remainingCents)}. Enforcement: HARD CAP. Agent control: NONE.`);
    audit(db, 'OVERSPEND_BLOCKED', `OVERSPEND ATTACK blocked by enforcement layer: requested $${dollars(amountCents)}, remaining $${dollars(debit.remainingCents)}`, { requestId, paymentId: payment.id });
    return {
      outcome: 'BLOCKED_BUDGET', requestId, idempotencyKey, requestedDollars: dollars(amountCents),
      remainingDollars: dollars(debit.remainingCents), chargedDollars: 0, paymentId: payment.id,
      paymentStatus: STATES.REJECTED_BUDGET, reason: 'HARD_BUDGET_LIMIT_EXCEEDED', enforcement: 'HARD_CAP', agentControl: 'NONE', steps,
    };
  }

  setPaymentStatus(db, payment.id, STATES.AUTHORIZED);
  setPaymentStatus(db, payment.id, STATES.PAID);
  const delivery = deliver(db, getPayment(db, payment.id)!);
  const verified = verifyDelivery(db, delivery.id);
  push('PAID', `Amount fit inside the budget, so SpendOath honestly allowed it ($${dollars(amountCents)}). Not an overspend.`);
  audit(db, 'PAYMENT_SETTLED', `Attack-lab amount was within budget and settled: $${dollars(amountCents)}`, { requestId, paymentId: payment.id });
  return {
    outcome: 'NOT_AN_OVERSPEND', requestId, idempotencyKey, requestedDollars: dollars(amountCents),
    remainingDollars: dollars(getPolicy(db, agentId)!.remainingCents), chargedDollars: dollars(amountCents),
    paymentId: payment.id, paymentStatus: STATES.VERIFIED, reason: 'WITHIN_BUDGET', enforcement: 'HARD_CAP', agentControl: 'NONE',
    steps, receipt: verified.receipt,
  };
}

export interface TamperResult {
  deliveryId: number;
  originalHash: string;
  tamperedArtifact: unknown;
  verify: VerifyResult;
}

export function tamperDelivery(db: DatabaseSync, deliveryId: number, tamperedOverride?: unknown): TamperResult {
  const d = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(deliveryId) as any;
  if (!d) throw new Error(`DELIVERY_NOT_FOUND: ${deliveryId}`);
  const payment = getPayment(db, asNumber(d.payment_id))!;
  const service = payment.serviceId != null ? getService(db, payment.serviceId) : null;

  const original = JSON.parse(d.result as string);
  let tampered: unknown;
  if (tamperedOverride !== undefined) {
    tampered = tamperedOverride;
  } else if (service?.name === 'AI Translation') {
    tampered = { ...original, target: `${original.target}!!!` }; // "Hello world!!!" style corruption
  } else if (service?.name === 'Compute Job') {
    tampered = { ...original, claimedSum: (original.claimedSum as number) + 1 };
  } else if (service?.name === 'Premium Code Audit') {
    tampered = { ...original, source: 'function clamp(x) { return x < 0 ? 0 : (x > 10 ? 10 : x); }', claim: original.claim };
  } else {
    tampered = { ...original, tampered: true, note: 'altered after delivery' };
  }

  db.prepare('UPDATE deliveries SET result = ? WHERE id = ?').run(JSON.stringify(tampered), deliveryId);
  audit(db, 'TAMPER_SIMULATED', `Delivered artifact for ${payment.requestId} was corrupted after delivery (demo)`, { requestId: payment.requestId, paymentId: payment.id, metadata: { deliveryId, originalHash: d.content_hash } });

  const verify = verifyDelivery(db, deliveryId);
  return { deliveryId, originalHash: d.content_hash, tamperedArtifact: tampered, verify };
}