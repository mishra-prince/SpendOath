import type { DatabaseSync } from 'node:sqlite';
import { seedCompromisedAgent } from './attacks';
import { asNumber, nowIso } from './db';

export const SEED = {
  userName: 'Prince Kumar Mishra',
  agentName: 'SpendOath Agent',
  budgetDollars: 10,
  services: [
    { name: 'AI Translation', dollars: 2, provider: 'Provider Alpha', vera: 'EXECUTABLE', description: 'Deterministic EN→ES machine translation of a demo phrase.' },
    { name: 'Compute Job', dollars: 4, provider: 'Provider Alpha', vera: 'EXECUTABLE', description: 'Aggregates a dataset; provider claims the sum. VERA recomputes it.' },
    { name: 'Data Storage', dollars: 3, provider: 'Provider Beta', vera: 'EXECUTABLE', description: 'Stores an object; provider claims a checksum. VERA recomputes it.' },
    { name: 'Premium Code Audit', dollars: 8, provider: 'Provider Beta', vera: 'EXECUTABLE', description: 'Provider claims a vulnerability in delivered code. VERA executes the code and checks the claim.' },
  ],
};

export function seed(db: DatabaseSync): void {
  const row = db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number | bigint };
  if (asNumber(row.c) > 0) return;

  const ts = nowIso();
  const userId = asNumber(db.prepare('INSERT INTO users (name) VALUES (?)').run(SEED.userName).lastInsertRowid);
  const agentId = asNumber(db.prepare('INSERT INTO agents (name, user_id, status) VALUES (?, ?, ?)').run(SEED.agentName, userId, 'ACTIVE').lastInsertRowid);

  const providerIds = new Map<string, number>();
  for (const name of ['Provider Alpha', 'Provider Beta']) {
    providerIds.set(name, asNumber(db.prepare('INSERT INTO providers (name) VALUES (?)').run(name).lastInsertRowid));
  }

  for (const s of SEED.services) {
    db.prepare('INSERT INTO services (name, price_cents, provider_id, description, vera_mode) VALUES (?, ?, ?, ?, ?)').run(
      s.name, Math.round(s.dollars * 100), providerIds.get(s.provider)!, s.description, s.vera,
    );
  }

  db.prepare('INSERT INTO policies (agent_id, max_budget_cents, spent_cents, currency, active) VALUES (?, ?, 0, ?, 1)').run(
    agentId, Math.round(SEED.budgetDollars * 100), 'USD',
  );

  // Register the Compromised-Agent for the Attack Lab (own Ed25519 keypair).
  seedCompromisedAgent(db, SEED.userName, 10, 4);

  db.prepare('INSERT INTO audit_events (type, description, metadata, timestamp) VALUES (?, ?, ?, ?)').run(
    'POLICY_CREATED',
    `Hard budget policy created for ${SEED.agentName}: $${SEED.budgetDollars} cap`,
    JSON.stringify({ agentId, maxBudgetDollars: SEED.budgetDollars, enforcement: 'SERVER_SIDE_HARD_CAP' }),
    ts,
  );
}

export function resetAll(db: DatabaseSync): void {
  const tables = ['nonce_registry', 'audit_events', 'deliveries', 'payments', 'policies', 'services', 'providers', 'agents', 'users'];
  for (const t of tables) db.exec(`DELETE FROM ${t};`);
  seed(db);
}