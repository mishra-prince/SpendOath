# SpendOath — Verified Agent Commerce

A deterministic, locally-runnable demo of **agentic payments with hard budget
enforcement and cryptographic delivery verification**.

- **SpendOath** is the enforcement platform: an autonomous agent can *ask*
  to spend, but it can never exceed the owner's hard budget cap. Budget
  enforcement is server-side; the agent has **no** control over it.
- **VERA** (Verification of Executed Results & Artifacts) is the delivery
  verifier: a paid service result is only accepted if its content hash matches
  the commitment recorded at payment time **and** the service's own claim
  recomputes correctly.

The whole thing speaks an **x402-compatible HTTP 402** flow (no external
network, no real money) so it runs offline on a laptop for a demo.

## Why it matters

Autonomous agents that pay for services create two failure modes:

1. **Runaway spend** — an agent (or a prompt-injected agent) drains a wallet.
2. **Paid-for-nothing** — the agent is charged, but the delivered artifact is
   wrong, truncated, or tampered with after the fact.

SpendOath closes (1) with a hard cap the agent cannot override, and closes (2)
by refusing to accept any artifact whose hash does not match the payment
commitment.

## The flow

```
Agent ──request──▶ GET /api/service/:id            (no payment → HTTP 402)
                        │
                        ▼
              SpendOath authorizes spend
                 ├─ within cap  → AUTHORIZED → PAID
                 └─ over cap    → REJECTED_BUDGET  (agent control: NONE)
                        │
                        ▼
              Provider delivers artifact  → content hash committed
                        │
                        ▼
              VERA executes the claim
                 ├─ hash matches + claim holds → CLAIM_VERIFIED
                 └─ hash mismatch / claim fails → CLAIM_NOT_VERIFIED
                        │
                        ▼
                  Verified receipt issued
```

## Endpoints

- `GET  /api/health` — liveness
- `POST /api/reset` — reset demo state (budget back to $10)
- `GET  /api/services` — list purchasable services
- `POST /api/policy` — set the hard budget cap (`{ maxBudgetDollars }`)
- `GET  /api/service/:serviceId?requestId=…` — x402 endpoint: 402 until paid, then 200
- `POST /api/payment` — direct settlement with idempotency key
- `POST /api/agent/request` — full agent flow (402 → pay → deliver → verify)
- `POST /api/retry` — idempotent retry (no second charge)
- `POST /api/attack/overspend` — deliberately attempt an over-budget spend
- `POST /api/attack/tamper` — corrupt a delivered artifact and re-verify
- `POST /api/verify` — verify a delivery
- `GET  /api/deliveries`, `GET /api/receipt/:paymentId`, `GET /api/dashboard`, `GET /api/audit`

## Run it

```bash
# backend (port 4000)
cd server && npm install && npm start

# frontend (port 5173 dev / 4173 preview), proxies /api → :4000
cd web && npm install && npm run dev
```

## Tests

```bash
cd server && npm test        # 15 passing
cd web && npm run build      # tsc -b && vite build
```

See `docs/ARCHITECTURE.md` for the state machine, enforcement points, and the
attack/defense matrix.