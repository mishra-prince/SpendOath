import { generateKeyPairSync, sign as edSign, verify as edVerify, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from './db';
import { uid } from './canonical';

/**
 * SpendOath cryptographic agent identity (hackathon-grade, deterministic).
 *
 * Honest scope: SpendOath can cryptographically identify and attribute agents
 * that are REGISTERED with SpendOath. An unknown agent or an unverified
 * signature is NOT authenticated — a client-claimed agentId alone proves
 * nothing.
 */

export interface KeyPairPem {
  publicKeyPem: string;
  privateKeyPem: string;
}

export function generateAgentKeypair(): KeyPairPem {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export function shortAgentId(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex').toUpperCase();
  return `agent_${h.slice(0, 4)}${h.slice(4, 8)}`;
}

/** Canonical payment-intent bytes that MUST be signed by the agent's private key. */
export interface IntentToSign {
  agentId: string;
  requestId: string;
  service: string;
  provider: string;
  amountCents: number;
  nonce: string;
  policyRef: string;
  destination: string;
}

export function canonicalIntentBytes(intent: IntentToSign): Buffer {
  // Deterministic, order-stable serialization. Any field change breaks the signature.
  const parts = [
    'SPENDOATH-INTENT-V1',
    `agentId=${intent.agentId}`,
    `requestId=${intent.requestId}`,
    `service=${intent.service}`,
    `provider=${intent.provider}`,
    `amountCents=${intent.amountCents}`,
    `nonce=${intent.nonce}`,
    `policyRef=${intent.policyRef}`,
    `destination=${intent.destination}`,
  ];
  return Buffer.from(parts.join('\n'), 'utf8');
}

export function signIntent(intent: IntentToSign, privateKeyPem: string): string {
  return edSign(null, canonicalIntentBytes(intent), privateKeyPem).toString('base64');
}

export function verifyIntentSignature(intent: IntentToSign, signatureB64: string, publicKeyPem: string): boolean {
  try {
    return edVerify(null, canonicalIntentBytes(intent), publicKeyPem, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

/** Register an agent with its own Ed25519 keypair + authority, bound to an owner. */
export function registerAgent(
  db: DatabaseSync,
  opts: { name: string; ownerName: string; budgetDollars: number; maxTxDollars: number; status?: string },
): { agentRowId: number; agentExternalId: string; publicKeyPem: string; privateKeyPem: string } {
  const kp = generateAgentKeypair();
  const agentExternalId = shortAgentId(kp.publicKeyPem);
  const owner = db.prepare('SELECT id FROM users WHERE name = ?').get(opts.ownerName) as { id: number | bigint } | undefined;
  const userId = owner
    ? Number(owner.id)
    : Number(db.prepare('INSERT INTO users (name) VALUES (?)').run(opts.ownerName).lastInsertRowid);
  const agentRowId = Number(
    db.prepare(
      "INSERT INTO agents (name, user_id, status, agent_external_id, public_key, private_key, max_tx_cents, nonce) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(opts.name, userId, opts.status ?? 'ACTIVE', agentExternalId, kp.publicKeyPem, kp.privateKeyPem, Math.round(opts.maxTxDollars * 100), uid('nonce')).lastInsertRowid,
  );
  return { agentRowId, agentExternalId, publicKeyPem: kp.publicKeyPem, privateKeyPem: kp.privateKeyPem };
}

/** Replay protection: a (agentId, requestId, nonce) signature can only be used once. */
export function checkAndBurnNonce(db: DatabaseSync, agentRowId: number, requestId: string, nonce: string): { ok: boolean; replay?: boolean } {
  const row = db.prepare('SELECT 1 FROM nonce_registry WHERE agent_id = ? AND request_id = ? AND nonce = ?').get(agentRowId, requestId, nonce);
  if (row) return { ok: false, replay: true };
  db.prepare('INSERT INTO nonce_registry (agent_id, request_id, nonce, used_at) VALUES (?, ?, ?, ?)').run(agentRowId, requestId, nonce, nowIso());
  return { ok: true };
}
