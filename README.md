# Solana Smart Transaction Stack — TJS Code

> **Superteam Nigeria Advanced Infrastructure Challenge submission**
> Built by Olatunde Olabanjo (TJS Code) | [GitHub](https://github.com/OlatundeOlabanj/smart-tx-stack)

---

## What It Does

The Solana Smart Transaction Stack is a backend infrastructure system that:

- **Submits real Solana devnet transactions** as Jito bundles with dynamically calculated tips derived from live Jito tip floor data
- **Tracks every transaction lifecycle stage** — Submitted → Processed → Confirmed → Finalized — with real timestamps (ISO 8601) and real slot numbers verifiable on Solana Explorer
- **Uses Helius RPC polling** (not gRPC streaming) for transaction state updates — an honest infrastructure decision explained in full below
- **Uses Groq AI (llama3-70b-8192) as the reasoning agent** for all failure and retry decisions — no hardcoded if/else retry logic exists anywhere in the codebase
- **Logs 10+ real bundle executions** with real signatures, real slots, and real timestamps to `logs/lifecycle.json` as verifiable proof

This is not a simulation. Slot numbers in `logs/lifecycle.json` can be cross-referenced on [Solana Explorer (devnet)](https://explorer.solana.com/?cluster=devnet).

---

## Setup

### Prerequisites

- Node.js 18+
- npm 9+

### Install

```bash
git clone https://github.com/OlatundeOlabanj/smart-tx-stack.git
cd smart-tx-stack
npm install
```

### Configure

The `.env` file is included with the required keys for this submission. No changes needed to run.

```env
HELIUS_API_KEY=b96310da-f003-412d-b2e9-5de7263da385
HELIUS_RPC_URL=https://devnet.helius-rpc.com/?api-key=b96310da-f003-412d-b2e9-5de7263da385
GROQ_API_KEY=your_groq_api_key_here
SOLANA_RPC_URL=https://devnet.helius-rpc.com/?api-key=b96310da-f003-412d-b2e9-5de7263da385
```

Optional: set `WALLET_PRIVATE_KEY` (base58) to reuse a funded wallet across runs. If unset, a fresh keypair is generated and automatically airdropped on devnet.

### Run

```bash
npx ts-node src/index.ts
```

Or with the npm script:

```bash
npm start
```

The system will:
1. Connect to Solana devnet via Helius RPC and log the current slot
2. Generate (or load) a wallet and airdrop 2 SOL if balance < 0.1 SOL
3. Execute 10 real transactions with dynamic Jito tips
4. Inject a stale blockhash fault after transaction 5
5. Run the Groq AI agent on every failure to make retry decisions
6. Write proof logs to `logs/lifecycle.json`
7. Print a full summary to stdout

**Note on fault injection:** After transaction 5, the system intentionally waits 90 seconds then submits a transaction with an already-expired blockhash. This triggers a real `ExpiredBlockhash` failure, which is then handed to the Groq agent for a real retry decision.

---

## Architecture Overview

```
src/
├── types/index.ts          Shared enums + interfaces (LifecycleEntry, AgentDecision, etc.)
├── ingestion/poller.ts     Helius RPC polling — getSignatureStatuses every 1.5s
├── execution/tips.ts       Dynamic tip calculator — live Jito tip floor API
├── execution/jito.ts       Jito bundle builder + submitter — devnet block engine
├── lifecycle/tracker.ts    Lifecycle state machine + proof log writer
├── agent/reasoner.ts       Groq AI reasoning agent — ONLY retry decision maker
└── index.ts                Main orchestrator — runs all 10 transactions
```

### Data Flow

```
Transaction Initiated (index.ts)
        │
        ▼
calculateDynamicTip() ──► Jito tip floor API (live)
        │
        ▼
buildAndSubmitBundle() ──► Jito devnet block engine
        │                  (fallback: standard sendRawTransaction)
        ▼
createEntry() ──► lifecycle/tracker.ts (submitted_at, slot_submitted)
        │
        ▼
pollTransactionStatus() ──► Helius RPC getSignatureStatuses (every 1.5s)
        │
   onStateChange callback
        │
        ├── Processed  ──► updateState() → processed_at, slot_landed
        ├── Confirmed  ──► updateState() → confirmed_at
        └── Finalized  ──► updateState() → finalized_at → SUCCESS
                │
           [if Failed]
                │
                ▼
        getNetworkContext() ──► current slot, avg confirmation ms, failure rate
                │
                ▼
        reasonAboutFailure() ──► Groq API (llama3-70b-8192)
                │
                ▼
        AgentDecision { should_retry, new_tip_lamports, reason, confidence_score }
                │
        [confidence >= 0.6 AND should_retry = true]
                │
                ▼
        Retry → buildAndSubmitBundle() → pollTransactionStatus()
                │
                ▼
        saveLog() ──► logs/lifecycle.json
```

### Component Responsibilities

| Component | Responsibility |
|---|---|
| `types/index.ts` | Single source of truth for all shared types — `LifecycleEntry`, `AgentDecision`, `NetworkContext`, enums |
| `ingestion/poller.ts` | Polls Helius RPC for real state transitions, records real timestamps and slot numbers, builds network context |
| `execution/tips.ts` | Fetches live Jito tip floor, maps urgency levels to percentile tiers, caches for 30s |
| `execution/jito.ts` | Builds two-transaction Jito bundles (user tx + tip tx), submits to devnet block engine, falls back gracefully |
| `lifecycle/tracker.ts` | State machine for each transaction, classifies failure types from error strings, writes proof log |
| `agent/reasoner.ts` | The only place retry decisions are made — sends full failure context to Groq, validates JSON response, enforces confidence gate |
| `index.ts` | Orchestrates the full pipeline, injects the stale blockhash fault, prints final summary |

---

## Infrastructure Decision: Polling + Webhooks vs. gRPC Streaming

### What the bounty says

The challenge mentions "any compatible Geyser stream provider." This system uses **Helius RPC polling + Helius webhooks** instead of Yellowstone gRPC streaming. This was a deliberate infrastructure decision, not a limitation.

### Why we chose polling

| Factor | Yellowstone gRPC | Helius RPC Polling (our choice) |
|---|---|---|
| **Cost** | $499/month (QuickNode) or $125 minimum (Triton) | Free tier on Helius |
| **Setup complexity** | Requires protobuf schemas, gRPC client, streaming connection management | Standard HTTP — works with Node.js fetch |
| **Reliability** | Streaming connections drop and require reconnection logic | Each poll is a stateless HTTP request — retries are trivial |
| **Latency** | ~100–300ms from block production | ~150–750ms depending on poll interval |
| **Devnet availability** | Limited — most gRPC providers do not support devnet | Full Helius devnet support |

### The real tradeoff

gRPC streaming gives you lower latency (roughly 2–5x faster state detection) because the server pushes events to you as they occur. With polling at 1500ms intervals, there is an inherent detection lag of up to 1.5 seconds per state transition. For a production MEV or arbitrage system where milliseconds matter, gRPC is the right choice.

For this submission — lifecycle tracking, proof logging, and AI-driven retry decisions — the 1.5s polling interval is more than sufficient. All proof data (slot numbers, timestamps, signatures) is real and verifiable regardless of whether state detection happened via push or pull.

**Conclusion:** If this system were to move to production at scale, replacing the poller with a Yellowstone gRPC subscription would be a single-component swap (`poller.ts`). The rest of the architecture is transport-agnostic by design.

---

## The Groq AI Agent

The agent in `src/agent/reasoner.ts` is the **only** place retry decisions are made. There is no hardcoded retry logic anywhere else in the codebase.

On every failed transaction, the agent receives:

- Full `LifecycleEntry` — signature, all timestamps, all slot numbers, tip paid, retry count, failure type
- `NetworkContext` — current slot, rolling average confirmation time, recent failure rate, congestion level

The system prompt instructs the model to reason about cost-benefit tradeoffs, failure types, and network conditions. It must return a JSON object with `should_retry`, `new_tip_lamports`, `reason`, and `confidence_score`.

**Confidence gate:** If `confidence_score < 0.6`, the system blocks the retry regardless of `should_retry`. This prevents the agent from committing SOL when it is uncertain.

---

## Three Key Questions

### Q1: What does the delta between `processed_at` and `confirmed_at` tell you about network health at the time of submission?

The `processed_at` → `confirmed_at` delta measures how long it took for a transaction to move from the first validator acknowledgment to cluster-wide supermajority confirmation (66%+ of stake weight). Under normal devnet conditions this delta is typically 400–800ms, reflecting roughly 2–4 slots. A delta above 3 seconds indicates validators are slow to vote — either because of cluster instability, a fork resolution event, or high transaction throughput overwhelming the pipeline. A delta above 8 seconds is a strong signal of serious congestion or a stall. In this system, these deltas are collected in a rolling window inside `poller.ts` and fed directly into the `NetworkContext` that the Groq AI agent receives — so the agent is making retry decisions informed by real, recent confirmation latency, not static thresholds.

### Q2: Why should you never use `finalized` commitment when fetching a blockhash for a time-sensitive transaction?

A blockhash fetched at `finalized` commitment is already 32 slots behind the current tip of the chain (finalization requires ~32 slot confirmations on Solana). Each slot is approximately 400ms, so a `finalized` blockhash is already roughly 12–13 seconds old at the moment you receive it. Blockhashes expire after 150 blocks (~60 seconds). That means you have already consumed roughly 20% of the blockhash's validity window before your transaction is even built. Under any congestion, your transaction will arrive at the block engine with a near-expired blockhash and will be dropped. Always fetch blockhash at `confirmed` commitment for time-sensitive submissions — it gives you the most recent confirmed blockhash while still being safe against minor forks, and leaves you the full validity window to submit.

### Q3: What happens to your bundle if the Jito leader skips their slot?

When a Jito leader skips their scheduled slot, the block engine's pending bundles for that slot are dropped. Unlike standard transactions which propagate across the gossip network and can be picked up by any upcoming leader, Jito bundles are routed specifically to the designated leader for atomic inclusion. If that leader skips, the bundle simply ceases to exist — it is not forwarded, not queued for the next leader, and not retried automatically by the block engine. The RPC will eventually report the transaction as not found, which manifests as a timeout in the lifecycle tracker. This system surfaces this event as `TransactionFailure.JitoLeaderSkipped` and hands it to the Groq agent, which typically recommends a retry with a moderately higher tip to secure inclusion with the next available Jito leader.

---

## Proof Logs

After running, `logs/lifecycle.json` will contain entries like:

```json
{
  "signature": "2io6vWqw95Li...",
  "submitted_at": "2026-05-31T07:40:17.000Z",
  "confirmed_at": "2026-05-31T07:40:29.109Z",
  "finalized_at": "2026-05-31T07:40:41.006Z",
  "slot_submitted": 466135218,
  "slot_landed": 466135224,
  "tip_paid_lamports": 1085,
  "retry_count": 0,
  "final_state": "Finalized"
}
```

**Real run — May 31, 2026 — All 10 transactions Finalized:**

| TX | Signature | Slot | State |
|---|---|---|---|
| #1 | 2io6vWqw95Li... | 466135224 | Finalized |
| #2 | PEhLgwz7iDu7... | 466135275 | Finalized |
| #3 | 5m8FSo6t61d3... | 466135326 | Finalized |
| #4 | 3We6qE8YrMZw... | 466135372 | Finalized |
| #5 | 4TfLEtFtnGKZ... | 466135424 | Finalized |
| #6 (FAULT) | 4iDynDaNv8KZ... | 466135715 | Finalized |
| #7 | j66LzdRsSZ5a... | 466135762 | Finalized |
| #8 | 4JC2pnHH5wza... | 466135812 | Finalized |
| #9 | tAenCigHut3a... | 466135860 | Finalized |
| #10 | xyuUFbEa1mv4... | 466135924 | Finalized |

Wallet: `BqEjkcszfUsJ6VuYa2kAqnnCE2Q1XHu6mxbjGxq1fZni`
Success rate: 100% | Avg confirmation: 1845ms | Total tips: 179,831 lamports

Verify any signature at: `https://explorer.solana.com/tx/<signature>?cluster=devnet`

---

## Architecture Document

### System Overview

The Solana Smart Transaction Stack is a TypeScript backend system designed around three core principles: **no synthetic data**, **AI-driven decisions**, and **honest infrastructure choices**. Every slot number, timestamp, and transaction signature in the output is real and externally verifiable.

The system operates as a sequential pipeline: transactions are built, submitted as Jito bundles, polled for lifecycle state via Helius RPC, and on failure, analyzed by a Groq AI agent that makes the sole retry decision. No hardcoded retry thresholds, no static tip values, and no simulated confirmations exist anywhere in the codebase.

### Component Diagram Description

```
┌─────────────────────────────────────────────────────────────┐
│                        index.ts (Orchestrator)              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │ tips.ts  │  │ jito.ts  │  │tracker.ts│  │reasoner.ts │  │
│  │          │  │          │  │          │  │            │  │
│  │Jito API  │  │Jito Block│  │lifecycle │  │Groq API    │  │
│  │tip floor │  │Engine    │  │state     │  │llama3-70b  │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └─────┬──────┘  │
│       │              │              │               │         │
│  ┌────▼──────────────▼──────────────▼───────────────▼──────┐ │
│  │               poller.ts (Helius RPC)                     │ │
│  │     getSignatureStatuses — polls every 1500ms            │ │
│  └──────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                    Solana Devnet (Helius RPC)
                    Jito devnet block engine
                    Groq API (llama3-70b-8192)
                    Jito tip floor API
```

### Where Hardcoded Logic Ends and AI Begins

All hardcoded logic handles infrastructure mechanics: building transactions, serializing bundles, making HTTP calls, parsing RPC responses, writing to disk. The boundary is explicit:

**Hardcoded (deterministic):**
- Transaction construction and signing
- Bundle serialization format
- RPC polling interval (1500ms) and timeout (90s)
- Tip percentile tiers (p25/p50/p75/p95)
- Confidence gate threshold (0.6)

**AI-driven (Groq agent):**
- Should this specific failed transaction be retried?
- What tip amount is appropriate for the retry given current network conditions?
- Why is this failure happening and what does it indicate about the network?
- How confident is the system in this decision?

The transition point is the `reasonAboutFailure()` call in `index.ts`. Before that call, everything is deterministic. After that call, the system acts on the AI's structured JSON output.

### Failure Handling Strategy

| Failure Type | Default Retry Tendency | Agent Override Possible |
|---|---|---|
| `ExpiredBlockhash` | Usually yes — fetch fresh blockhash | Yes — agent may reject on high congestion |
| `FeeTooLow` | Yes — increase tip | Yes — agent calculates new tip |
| `ComputeBudgetExceeded` | No — code issue | Yes — agent may identify congestion as cause |
| `BundleExecutionFailure` | Conditional | Yes — agent weighs conditions |
| `JitoLeaderSkipped` | Yes — transient | Yes — agent recommends higher tip |
| `Timeout` | Only on low congestion | Yes — primary decision maker |

### Infrastructure Choices and Reasoning

**Helius over other RPC providers:** Helius free tier provides generous rate limits on devnet and has reliable `getSignatureStatuses` support. Their API is stable and well-documented.

**Jito bundles over standard transactions:** Jito bundles provide atomicity and priority ordering. For production systems, this is critical for MEV protection and predictable inclusion. On devnet, they demonstrate the infrastructure pattern even when the economic incentives are not real.

**Groq over OpenAI for the agent:** Groq's llama3-70b-8192 provides sub-second inference for structured JSON outputs. For an infrastructure agent that must make decisions mid-transaction pipeline, latency matters. Groq's hardware-accelerated inference at free tier makes it the practical choice for this submission.

**TypeScript over Rust:** The @solana/web3.js ecosystem is mature and the Jito TypeScript SDK is well-maintained. For an infrastructure system where developer velocity and ecosystem tooling matter more than raw runtime performance, TypeScript is the right choice.

---

*Made by TJS Code — Olatunde Olabanjo*
*Superteam Nigeria Advanced Infrastructure Challenge*
