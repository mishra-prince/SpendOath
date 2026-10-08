# SpendOath — Architecture

## Components

- **`server/`** — Express + `node:sqlite` (`node --import tsx`). Deterministic, in-process, no external network.
  - `app.ts` — HTTP routes and the x402 402-vs-200 surface
  - `engine.ts` — the agent flow, delivery, verification, retry, and both attack labs
  - `payments.ts` — the payment state machine (transition table + `assertTransition`)
  - `policy.ts` — the hard budget cap and `tryDebit` (the single enforcement point)
  - `vera.ts` — the verifier: recomputes the artifact hash and the service's own claim
  - `services.ts` — deterministic service "providers" (translation, compute, storage, code audit)
  - `canonical.ts` — canonical JSON + `sha256` artifact hashing (`uid()` for ids)
  - `seed.ts` / `db.ts` — schema and deterministic seed data
- **`web/`** — React + Vite + TS + Tailwind dashboard (tabs: overview, agent, market, stream, attack, verify, audit, demo). Proxies `/api` to `:4000`.

## Payment state machine

```
REQUESTED → PAYMENT_REQUIRED → AUTHORIZED → PAID → DELIVERED → VERIFIED
                   │                │
                   ▼                ▼
            REJECTED_BUDGET      FAILED
            REJECTED_DUPLICATE   EXPIRED
```

Transitions are enforced in `payments.ts` — any illegal edge throws
`ILLEGAL_PAYMENT_STATE_TRANSITION`. Terminal states (`VERIFIED`, `REJECTED_*`,
`FAILED`, `EXPIRED`) have no outgoing edges, so a settled payment can never be
re-charged or silently re-opened.

## The two enforcement points

1. **Budget (SpendOath).** `policy.tryDebit` is the *only* place money moves. It
   checks `remaining >= amount`, and on failure sets `REJECTED_BUDGET` and
   returns without charging. The agent calls `agentRequest`, which *asks*
   `tryDebit`; it cannot bypass it. Budget enforcement is server-side and
   stateless w.r.t. the agent's intent.

2. **Delivery (VERA).** `verifyDelivery` recomputes `sha256(canonical(artifact))`
   and compares it to the hash committed at payment time, then runs the
   service-specific claim check. A mismatch (or a failing claim) yields
   `CLAIM_NOT_VERIFIED`; VERA **refuses to execute** an artifact whose content
   hash does not match the commitment. Only `CLAIM_VERIFIED` + `hashValid`
   promotes the payment to `VERIFIED` and issues the receipt.

## Idempotency

- Every request carries an `idempotencyKey`. `/api/payment` and `/api/retry`
  look it up first: a replay returns the original payment with `$0` charged and
  logs `IDEMPOTENT_RETRY` / `DUPLICATE_PAYMENT_BLOCKED`.
- Same `requestId` with a *different* idempotency key → `409 IDEMPOTENCY_CONFLICT`.
- `POST /api/agent/request` intentionally mints a fresh request per call (it
  models a new agent action). Dedup is a property of retry/replay, not of
  independent new requests.

## Attack / defense matrix

| Attack | Endpoint | Expected result | Verified |
|---|---|---|---|
| Over-budget spend | `POST /api/attack/overspend` | `BLOCKED_BUDGET`, `$0` charged, `enforcement: HARD_CAP`, `agentControl: NONE` | ✅ |
| Post-delivery tamper | `POST /api/attack/tamper` | `CLAIM_NOT_VERIFIED`, `hashValid:false`, delivery `FAILED` | ✅ |
| Duplicate payment | `POST /api/retry` | `$0` charged, original returned | ✅ |
| Illegal transition | state machine | throws `ILLEGAL_PAYMENT_STATE_TRANSITION` | ✅ (unit-tested) |

## Receipt

`buildReceipt` composes: authorization (budget before/after, allowed),
payment (status + timestamp), delivery (received + artifact hash), VERA
verification (verifier, executionId, claim, observedResult, verdict, evidence,
recomputed vs. commitment hash), and a final integrity block (`hashAlgorithm:
sha256`, `hashValid`). `finalStatus` ∈ `VERIFIED | FAILED | PENDING | REJECTED`.

## Verification performed

- `server`: **15/15** tests pass (`node --test`).
- Live HTTP run against `:4000`: 402 → pay → deliver → VERA `CLAIM_VERIFIED`
  (hash valid); tamper → `CLAIM_NOT_VERIFIED` + `hashValid:false`; retry after
  simulated network failure → `$0` charged, `duplicateBlocks:1`.
- `web`: production build succeeds (`tsc -b && vite build`).
- Browser UI: not exercised — the browser tool was misconfigured
  (`browser-use` plugin unregistered) during this session. Core behavior was
  exercised over live HTTP instead.
## §18 On-chain settlement path (optional increment, implemented)

`contracts/SpendOathEscrow.sol` (Solidity ^0.8.24, compiles clean under solc
with 200-run optimizer) mirrors the off-chain engine's three guarantees on
EVM:

| Off-chain enforcement engine | On-chain equivalent |
|---|---|
| Hard budget cap in `policy` + `engine.ts` | `budgetCap[payer]` checked inside `authorize()` — the only path to settle; agent cannot bypass |
| Idempotency key dedup in `/api/payment` + `/api/retry` | `intentOfKey[payer][key]` — same key returns the SAME intent (`DuplicateIntent`), never a second charge |
| VERA hash verification (`vera.ts`: recompute, don't trust) | `markDelivered(id, deliveryHash)` commits SHA-256; `verifyDelivery(id, recomputedHash)` compares commitments on-chain |

Key design point carried over: the human (`setBudgetCap`, `msg.sender`)
holds the key; the agent has none. `spent[payer]` is incremented exactly
once, in `settle()` — mirroring the server's single-charge guarantee.

Verified: `solc` compile → OK, 22 ABI entries, 2883 B bytecode,
functions: authorize, budgetCap, createIntent, intentOfKey, intents,
markDelivered, nextId, settle, spent, verifyDelivery.
Deployment/testnet wiring is left as future work (demo runs the
deterministic off-chain engine).
