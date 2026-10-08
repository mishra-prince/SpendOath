import express, { type Express } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { asNumber, dollars, nowIso, toCents } from './db';
import { getPolicy, setPolicy } from './policy';
import {
  agentRequest, audit, buildReceipt, deliver, getService, listServices,
  overspendAttack, retryRequest, tamperDelivery, verifyDelivery,
} from './engine';
import { findPaymentByIdempotencyKey, findPaymentByRequestId, createPayment, setPaymentStatus, STATES, getPayment } from './payments';
import { resetAll } from './seed';
import { attackCompromisedAgent, attackUnknownAgent, attackSpoofedIdentity, attackFakeClientBudget, attackExpiredPolicy, attackRestrictedService, attackReplay, attackDestinationHijack, type AttackResult } from './attacks';
import { createHash } from 'node:crypto';

const REJECTED_LIKE = new Set(['REQUESTED', 'PAYMENT_REQUIRED', 'REJECTED_BUDGET', 'REJECTED_DUPLICATE', 'FAILED', 'EXPIRED']);

export function createApp(db: DatabaseSync): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, product: 'SpendOath', mode: 'local deterministic simulation (x402-compatible HTTP 402)', time: nowIso() });
  });

  app.post('/api/reset', (_req, res) => {
    resetAll(db);
    res.json({ ok: true, message: 'Demo state reset. Budget restored to $10.' });
  });

  app.get('/api/services', (_req, res) => {
    res.json({ services: listServices(db) });
  });

  app.post('/api/policy', (req, res) => {
    const agentId = asNumber((db.prepare('SELECT id FROM agents ORDER BY id LIMIT 1').get() as any).id);
    const maxBudgetDollars = Number(req.body?.maxBudgetDollars ?? 10);
    if (!(maxBudgetDollars > 0)) return res.status(400).json({ error: 'INVALID_BUDGET' });
    const p = setPolicy(db, agentId, toCents(maxBudgetDollars));
    audit(db, 'POLICY_CREATED', `Hard budget policy set: $${maxBudgetDollars}`, { metadata: { agentId, maxBudgetDollars } });
    res.json({ policy: { ...p, maxBudgetDollars: dollars(p.maxBudgetCents), spentDollars: dollars(p.spentCents), remainingDollars: dollars(p.remainingCents) } });
  });

  /**
   * The real x402-style flow. Without a paid request this endpoint answers
   * HTTP 402 Payment Required; after settlement it answers HTTP 200 with the
   * actual service result.
   */
  app.get('/api/service/:serviceId', (req, res) => {
    const service = getService(db, Number(req.params.serviceId));
    if (!service) return res.status(404).json({ error: 'SERVICE_NOT_FOUND' });
    const requestId = typeof req.query.requestId === 'string' ? req.query.requestId : '';
    const payment = requestId ? findPaymentByRequestId(db, requestId) : null;

    if (!payment || REJECTED_LIKE.has(payment.status)) {
      return res.status(402).json({
        status: 402,
        paymentRequired: true,
        amount: dollars(service.priceCents),
        currency: 'USD',
        service: service.name,
        serviceId: service.id,
        provider: service.providerName,
        requestId: requestId || null,
        paymentEndpoint: '/api/payment',
        note: 'Local x402-compatible HTTP 402 simulation (no external network required).',
      });
    }

    const delivery = deliver(db, payment);
    return res.status(200).json({
      serviceResult: JSON.parse(delivery.result),
      receipt: {
        deliveryId: delivery.id,
        paymentId: payment.id,
        requestId: payment.requestId,
        contentHash: delivery.contentHash,
        verificationStatus: delivery.verificationStatus,
      },
    });
  });

  app.post('/api/payment', (req, res) => {
    const { requestId, idempotencyKey, serviceId } = req.body ?? {};
    if (typeof requestId !== 'string' || typeof idempotencyKey !== 'string') {
      return res.status(400).json({ error: 'requestId and idempotencyKey are required' });
    }

    const byKey = findPaymentByIdempotencyKey(db, idempotencyKey);
    if (byKey) {
      audit(db, 'DUPLICATE_PAYMENT_BLOCKED', `Idempotent replay: existing payment returned, $0 charged (${requestId})`, { requestId: byKey.requestId, paymentId: byKey.id });
      return res.json({ duplicate: true, chargedDollars: 0, payment: byKey, receipt: buildReceipt(db, byKey.id) });
    }
    const byRequest = findPaymentByRequestId(db, requestId);
    if (byRequest && byRequest.idempotencyKey !== idempotencyKey) {
      audit(db, 'DUPLICATE_PAYMENT_BLOCKED', `Same requestId with a DIFFERENT idempotency key rejected`, { requestId, paymentId: byRequest.id });
      return res.status(409).json({ error: 'IDEMPOTENCY_CONFLICT', status: 'REJECTED_DUPLICATE', originalPaymentId: byRequest.id });
    }

    const agentId = asNumber((db.prepare('SELECT id FROM agents ORDER BY id LIMIT 1').get() as any).id);
    const service = serviceId != null ? getService(db, Number(serviceId)) : null;
    if (!service) return res.status(404).json({ error: 'SERVICE_NOT_FOUND' });

    let payment = byRequest;
    if (!payment) {
      const policy = getPolicy(db, agentId)!;
      payment = createPayment(db, {
        requestId, idempotencyKey, agentId, providerId: service.providerId, serviceId: service.id,
        amountCents: service.priceCents, spentBeforeCents: policy.spentCents, remainingBeforeCents: policy.remainingCents,
      });
      setPaymentStatus(db, payment.id, STATES.PAYMENT_REQUIRED);
    }

    const result = agentlessPay(db, payment.id);
    if (!result.allowed) {
      return res.status(402).json({ status: 'REJECTED_BUDGET', ...result });
    }
    res.json({ duplicate: false, chargedDollars: result.chargedDollars, payment: getPayment(db, payment.id), receipt: buildReceipt(db, payment.id) });
  });

  app.post('/api/agent/request', (req, res) => {
    const serviceId = Number(req.body?.serviceId);
    const simulateNetworkFailure = Boolean(req.body?.simulateNetworkFailure);
    try {
      const result = agentRequest(db, { serviceId, simulateNetworkFailure });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/retry', (req, res) => {
    const { requestId, idempotencyKey } = req.body ?? {};
    if (typeof requestId !== 'string' || typeof idempotencyKey !== 'string') {
      return res.status(400).json({ error: 'requestId and idempotencyKey are required' });
    }
    const result = retryRequest(db, { requestId, idempotencyKey });
    if (result.outcome === 'NOT_FOUND') return res.status(404).json(result);
    res.json(result);
  });

  app.post('/api/attack/overspend', (req, res) => {
    try {
      const result = overspendAttack(db, {
        serviceId: req.body?.serviceId != null ? Number(req.body.serviceId) : undefined,
        amountDollars: req.body?.amountDollars != null ? Number(req.body.amountDollars) : undefined,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/verify', (req, res) => {
    const deliveryId = Number(req.body?.deliveryId);
    try {
      res.json(verifyDelivery(db, deliveryId));
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.post('/api/attack/tamper', (req, res) => {
    const deliveryId = Number(req.body?.deliveryId);
    try {
      res.json(tamperDelivery(db, deliveryId, req.body?.tamperedArtifact));
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  // ---------- SPENDOATH ATTACK LAB (real firewall, real enforcement) ----------
  app.post('/api/attack-lab/run', (req, res) => {
    const kind = String(req.body?.attack ?? '');
    const amountDollars = req.body?.amountDollars != null ? Number(req.body.amountDollars) : 8;
    try {
      let result: AttackResult;
      switch (kind) {
        case 'compromised_agent':      result = attackCompromisedAgent(db, { amountDollars, serviceName: String(req.body?.serviceName ?? 'AI Translation'), providerName: req.body?.providerName, fakeClientBudget: req.body?.fakeClientBudget, destination: req.body?.destination }); break;
        case 'unknown_agent':          result = attackUnknownAgent(db, { amountDollars }); break;
        case 'spoofed_identity':       result = attackSpoofedIdentity(db, { amountDollars }); break;
        case 'fake_client_budget':     result = attackFakeClientBudget(db, { amountDollars }); break;
        case 'policy_expired':         result = attackExpiredPolicy(db, { amountDollars }); break;
        case 'restricted_service':     result = attackRestrictedService(db, { amountDollars, serviceName: String(req.body?.serviceName ?? 'Unlisted Service') }); break;
        case 'replay':                 result = attackReplay(db, { amountDollars }); break;
        case 'destination_hijack':     result = attackDestinationHijack(db, { amountDollars }); break;
        default: return res.status(400).json({ error: `unknown attack: ${kind}` });
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/attack-lab/agents', (_req, res) => {
    const rows = db.prepare('SELECT id, name, agent_external_id, status, max_tx_cents, public_key FROM agents ORDER BY id').all() as any[];
    res.json({ agents: rows.map((r) => ({ id: asNumber(r.id), name: r.name, agentExternalId: r.agent_external_id, status: r.status, maxTxDollars: r.max_tx_cents != null ? dollars(asNumber(r.max_tx_cents)) : null, publicKeyFingerprint: r.public_key ? createHash('sha256').update(String(r.public_key)).digest('hex').slice(0, 16) : null })) });
  });

  app.get('/api/deliveries', (_req, res) => {
    const rows = db.prepare('SELECT d.*, p.request_id AS req, p.amount_cents, s.name AS service FROM deliveries d JOIN payments p ON p.id = d.payment_id LEFT JOIN services s ON s.id = p.service_id ORDER BY d.id DESC').all() as any[];
    res.json({
      deliveries: rows.map((r) => ({
        id: asNumber(r.id), paymentId: asNumber(r.payment_id), requestId: r.request_id,
        service: r.service, amountDollars: dollars(asNumber(r.amount_cents)),
        contentHash: r.content_hash, verificationStatus: r.verification_status,
        veraVerdict: r.vera_verdict, verifiedAt: r.verified_at, result: JSON.parse(r.result),
      })),
    });
  });

  app.get('/api/receipt/:paymentId', (req, res) => {
    const p = getPayment(db, Number(req.params.paymentId));
    if (!p) return res.status(404).json({ error: 'PAYMENT_NOT_FOUND' });
    res.json({ receipt: buildReceipt(db, p.id) });
  });

  app.get('/api/dashboard', (_req, res) => {
    const agent = db.prepare('SELECT * FROM agents ORDER BY id LIMIT 1').get() as any;
    const user = db.prepare('SELECT * FROM users ORDER BY id LIMIT 1').get() as any;
    // Aggregate across ALL agents under this owner (main agent + Compromised-Agent etc.)
    const owners = db.prepare('SELECT id FROM users ORDER BY id').all() as any[];
    const ownerIds = owners.map((u) => asNumber(u.id));
    const agg = db.prepare(
      `SELECT SUM(p.max_budget_cents) AS maxC, SUM(p.spent_cents) AS spentC
       FROM policies p JOIN agents a ON a.id = p.agent_id WHERE a.user_id IN (${ownerIds.map(() => '?').join(',')})`,
    ).get(...ownerIds) as any;
    const policy = getPolicy(db, asNumber(agent.id));
    const payments = db.prepare(
      `SELECT p.*, s.name AS service_name, pr.name AS provider_name, d.verification_status, d.id AS delivery_id
       FROM payments p LEFT JOIN services s ON s.id = p.service_id LEFT JOIN providers pr ON pr.id = p.provider_id
       LEFT JOIN deliveries d ON d.payment_id = p.id ORDER BY p.id DESC`,
    ).all() as any[];

    const settled = payments.filter((p) => ['PAID', 'DELIVERED', 'VERIFIED'].includes(p.status));
    const maxC = asNumber(agg?.maxC) || asNumber(policy?.maxBudgetCents);
    const spentC = asNumber(agg?.spentC);
    res.json({
      user: { name: user.name },
      agent: { id: asNumber(agent.id), name: agent.name, status: agent.status },
      policy: {
        maxBudgetDollars: dollars(maxC),
        spentDollars: dollars(spentC),
        remainingDollars: dollars(maxC - spentC),
        utilizationPct: maxC === 0 ? 0 : Math.round((spentC / maxC) * 100),
        currency: policy?.currency ?? 'USD',
        active: policy?.active ?? true,
      },
      counts: {
        settledPayments: settled.length,
        verifiedDeliveries: payments.filter((p) => p.verification_status === 'VERIFIED').length,
        blockedAttempts: payments.filter((p) => p.status === 'REJECTED_BUDGET').length,
        failedVerifications: payments.filter((p) => p.verification_status === 'FAILED').length,
        duplicateBlocks: asNumber((db.prepare("SELECT COUNT(*) AS c FROM audit_events WHERE type IN ('DUPLICATE_PAYMENT_BLOCKED','IDEMPOTENT_RETRY')").get() as any).c),
      },
      services: listServices(db),
      transactions: payments.map((p) => ({
        id: asNumber(p.id), requestId: p.request_id, service: p.service_name ?? 'Custom spend',
        provider: p.provider_name, amountDollars: dollars(asNumber(p.amount_cents)),
        status: p.status, verification: p.verification_status ?? null, deliveryId: p.delivery_id ? asNumber(p.delivery_id) : null,
        createdAt: p.created_at,
      })),
    });
  });

  app.get('/api/audit', (_req, res) => {
    const rows = db.prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT 200').all() as any[];
    res.json({
      events: rows.map((r) => ({
        id: asNumber(r.id), type: r.type, requestId: r.request_id, paymentId: r.payment_id,
        description: r.description, metadata: JSON.parse(r.metadata || '{}'), timestamp: r.timestamp,
      })),
    });
  });

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err?.message ?? 'INTERNAL_ERROR' });
  });

  return app;
}

/** Direct payment settlement used by POST /api/payment (server-side enforcement only). */
function agentlessPay(db: DatabaseSync, paymentId: number): { allowed: boolean; chargedDollars: number; reason?: string; remainingDollars?: number } {
  const payment = getPayment(db, paymentId)!;
  const { tryDebit } = require_policy();
  const debit = tryDebit(db, payment.agentId, payment.amountCents);
  if (!debit.ok) {
    setPaymentStatus(db, paymentId, STATES.REJECTED_BUDGET);
    audit(db, 'OVERSPEND_BLOCKED', `Payment BLOCKED by hard cap: requested $${dollars(payment.amountCents)}, remaining $${dollars(debit.remainingCents)}`, { requestId: payment.requestId, paymentId });
    return { allowed: false, chargedDollars: 0, reason: debit.reason, remainingDollars: dollars(debit.remainingCents) };
  }
  setPaymentStatus(db, paymentId, STATES.AUTHORIZED);
  setPaymentStatus(db, paymentId, STATES.PAID);
  audit(db, 'PAYMENT_SETTLED', `Payment settled: $${dollars(payment.amountCents)}`, { requestId: payment.requestId, paymentId });
  return { allowed: true, chargedDollars: dollars(payment.amountCents) };
}

// avoid circular import at module top
import * as policyMod from './policy';
function require_policy() {
  return { tryDebit: policyMod.tryDebit };
}