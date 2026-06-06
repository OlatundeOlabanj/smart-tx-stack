# Solana Smart Transaction Stack — TJS Code

> **Superteam Nigeria Advanced Infrastructure Challenge submission**
> Built by Olatunde Olabanjo (TJS Code) | [GitHub](https://github.com/OlatundeOlabanj/smart-tx-stack)

---

## What It Does

The Solana Smart Transaction Stack is a backend infrastructure system that:

- **Submits real Solana devnet transactions** as Jito bundles with dynamically calculated tips derived from live Jito tip floor data
- **Tracks every transaction lifecycle stage** — Submitted → Processed → Confirmed → Finalized — with real timestamps (ISO 8601) and real slot numbers verifiable on Solana Explorer
- **Uses Helius RPC polling** for transaction state updates, with a Yellowstone gRPC stream component (via SolInfra) that falls back gracefully when unavailable
- **Uses Groq AI (llama3-70b-8192) as the sole reasoning agent** for all failure and retry decisions — no hardcoded if/else retry logic exists anywhere in the codebase
- **Logs 10+ real bundle executions** with real signatures, real slots, real timestamps, tip trails, and agent decision records to `logs/lifecycle.json`
- **Auto-generates `AGENT_MEMORY.md`** after each run — a human-readable summary of what the agent observed, decided, and recommends for the next run
- **Includes `LIVE_DASHBOARD.html`** — open in browser, drop `lifecycle.json`, visualize all transactions with lifecycle stages, tip escalation charts, and agent decision cards

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

Copy `.env.example` to `.env` and fill in your keys:

```env
HELIUS_RPC_URL=https://devnet.helius-rpc.com/?api-key=your_helius_api_key
GROQ_API_KEY=your_groq_api_key
SOLINFRA_GRPC_ENDPOINT=fra.grpc.solinfra.dev:443
SOLINFRA_GRPC_KEY=your_solinfra_grpc_key
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
2. Attempt Yellowstone gRPC stream init via SolInfra — falls back to RPC polling if unavailable
3. Generate (or load) a wallet and airdrop 2 SOL if balance < 0.1 SOL
4. Execute 10 real transactions with dynamic Jito tips across urgency tiers (LOW → CRITICAL)
5. Log tip trail per transaction — every tip amount, congestion level, and percentile recorded
6. Inject a stale blockhash fault on transaction #6
7. Run the Groq AI agent on every failure — full structured decision record stored per transaction
8. Write proof logs to `logs/lifecycle.json`
9. Auto-generate `AGENT_MEMORY.md` with run summary and next-run recommendation
10. Print a full summary to stdout

**Note on fault injection:** After transaction 5, the system intentionally waits 90 seconds then submits a transaction with an already-expired blockhash. This triggers a real `ExpiredBlockhash` failure, which is then handed to the Groq agent for a real retry decision.

### View Dashboard

Open `LIVE_DASHBOARD.html` in any browser. Click **Load lifecycle.json** and select `logs/lifecycle.json`. No server needed — works completely offline.

---

## Architecture Overview

```
src/
├── types/index.ts            Shared enums + interfaces (LifecycleEntry, AgentDecision, TipTrailEntry, AgentDecisionRecord)
├── ingestion/poller.ts       Helius RPC polling — getSignatureStatuses every 1.5s
├── ingestion/geyser.ts       Yellowstone gRPC stream via SolInfra — falls back to polling
├── execution/tips.ts         Dynamic tip calculator — live Jito tip floor API
├── execution/jito.ts         Jito bundle builder + submitter — devnet block engine
├── lifecycle/tracker.ts      Lifecycle state machine + proof log writer
├── agent/reasoner.ts         Groq AI reasoning agent — ONLY retry decision maker
├── reports/agentMemory.ts    Auto-generates AGENT_MEMORY.md after each run
└── index.ts                  Main orchestrator — runs all 10 transactions
```

### Data Flow

```
Transaction Initiated (index.ts)
        │
        ▼
calculateDynamicTip(urgency) ──► Jito tip floor API (live, cached 30s)
        │
        ▼
appendTipTrail() ──► tracker.ts (attempt #, lamports, congestion, percentile)
        │
        ▼
buildAndSubmitBundle() ──► Jito devnet block engine
        │                  (fallback: standard sendRawTransaction)
        ▼
createEntry() ──► lifecycle/tracker.ts (submitted_at, slot_submitted)
        │
        ▼
pollTransactionStatus() ──► Helius RPC getSignatureStatuses (every 1.5s)
        │                   [+ Geyser slot stream if available]
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
        appendAgentDecision() ──► tracker.ts (full structured record stored)
                │
        [confidence >= 0.6 AND should_retry = true]
                │
                ▼
        appendTipTrail() ──► retry tip logged
                │
                ▼
        Retry → buildAndSubmitBundle() → pollTransactionStatus()
                │
                ▼
        saveLog() ──► logs/lifecycle.json
        generateAgentMemory() ──► AGENT_MEMORY.md
```

### Component Responsibilities

| Component | Responsibility |
|---|---|
| `types/index.ts` | Single source of truth for all shared types — `LifecycleEntry`, `AgentDecision`, `TipTrailEntry`, `AgentDecisionRecord`, enums |
| `ingestion/poller.ts` | Polls Helius RPC for real state transitions, records real timestamps and slot numbers, builds network context |
| `ingestion/geyser.ts` | Yellowstone gRPC subscription via SolInfra — provides real-time slot updates, falls back gracefully |
| `execution/tips.ts` | Fetches live Jito tip floor, maps urgency levels to percentile tiers (p25/p50/p75/p95), caches for 30s |
| `execution/jito.ts` | Builds two-transaction Jito bundles (user tx + tip tx), submits to devnet block engine, falls back gracefully |
| `lifecycle/tracker.ts` | State machine for each transaction, records tip trails and agent decisions, classifies failure types, writes proof log |
| `agent/reasoner.ts` | The only place retry decisions are made — sends full failure context to Groq, validates JSON response, enforces confidence gate |
| `reports/agentMemory.ts` | Analyses completed run, generates AGENT_MEMORY.md with observations, patterns, and next-run recommendation |
| `index.ts` | Orchestrates the full pipeline, injects the stale blockhash fault, prints final summary |

---

## Infrastructure Decision: Polling vs. gRPC Streaming

### What the bounty says

The challenge requires "any compatible Geyser stream provider." This system includes both:

1. **`src/ingestion/geyser.ts`** — a Yellowstone gRPC stream component via SolInfra (`fra.grpc.solinfra.dev:443`) that subscribes to slot updates and transaction confirmations in real time
2. **`src/ingestion/poller.ts`** — Helius RPC polling as the primary lifecycle tracker and fallback

### Why both exist

| Factor | Yellowstone gRPC (geyser.ts) | Helius RPC Polling (poller.ts) |
|---|---|---|
| **Latency** | ~100–300ms from block production | ~150–750ms depending on poll interval |
| **Reliability** | Streaming connections can drop | Each poll is stateless — retries are trivial |
| **Lifecycle detail** | Slot updates + tx confirmations | Full commitment stage tracking with timestamps |
| **Role in this system** | Real-time slot stream, congestion signal | Primary lifecycle state machine |

### The real tradeoff

gRPC streaming gives lower latency because the server pushes events as they occur. With polling at 1500ms intervals, there is an inherent detection lag per state transition. For a production MEV or arbitrage system where milliseconds matter, gRPC is the primary transport. For this submission, the gRPC stream provides slot context and congestion signals, while the poller handles the full lifecycle state machine with precise timestamps.

**Conclusion:** The architecture is transport-agnostic by design. Replacing the poller entirely with a Yellowstone subscription would be a single-component swap. Both components exist and are wired in production.

---

## The Groq AI Agent

The agent in `src/agent/reasoner.ts` is the **only** place retry decisions are made. There is no hardcoded retry logic anywhere else in the codebase.

On every failed transaction, the agent receives:

- Full `LifecycleEntry` — signature, all timestamps, all slot numbers, tip paid, retry count, failure type, full tip trail
- `NetworkContext` — current slot, rolling average confirmation time, recent failure rate, congestion level

The system prompt instructs the model to reason about cost-benefit tradeoffs, failure types, and network conditions. It must return a JSON object with `should_retry`, `new_tip_lamports`, `reason`, and `confidence_score`.

**Confidence gate:** If `confidence_score < 0.6`, the system blocks the retry regardless of `should_retry`. This prevents the agent from committing SOL when it is uncertain.

**Structured decision record:** Every agent decision is stored as a full `AgentDecisionRecord` in `lifecycle.json` — including the failure type, full network context at decision time, Groq's complete response, and whether the confidence gate passed. This makes every AI decision auditable.

**AGENT_MEMORY.md:** After each run, the system auto-generates a markdown report summarising what the agent observed, tip escalation patterns, congestion levels, sample reasoning excerpts, and a recommendation for the next run.

---

## Tip Trail

Every transaction records a `tip_trail` array in `lifecycle.json`. Each entry captures:

- `attempt` — which submission attempt this tip belongs to
- `tip_lamports` — exact lamports paid
- `congestion_level` — network congestion at submission time (LOW/MEDIUM/HIGH/CRITICAL)
- `percentile` — which Jito tip floor percentile was used (p25/p50/p75/p95)
- `submitted_at` — ISO timestamp

This makes tip escalation across retries fully visible and auditable. The `LIVE_DASHBOARD.html` renders tip trails as bar charts per transaction.

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

After running, `logs/lifecycle.json` contains entries with full tip trails and agent decisions:

```json
{
  "signature": "4q2tQHGwhmYS...",
  "submitted_at": "2026-06-05T12:20:22.000Z",
  "confirmed_at": "2026-06-05T12:20:35.354Z",
  "finalized_at": "2026-06-05T12:20:47.232Z",
  "slot_submitted": 467320587,
  "slot_landed": 467320594,
  "tip_paid_lamports": 1000,
  "retry_count": 0,
  "final_state": "Finalized",
  "tip_trail": [
    {
      "attempt": 1,
      "tip_lamports": 1000,
      "congestion_level": "LOW",
      "percentile": "p25",
      "submitted_at": "2026-06-05T12:20:22.000Z"
    }
  ],
  "agent_decisions": []
}
```

**Real run — June 5, 2026 — All 10 transactions Finalized:**

| TX | Signature | Slot | Tip | State |
|---|---|---|---|---|
| #1 | 4q2tQHGwhmYS... | 467320594 | 1,000 lam | Finalized |
| #2 | 9U3uFZRvZip1... | 467320642 | 1,000 lam | Finalized |
| #3 | 3MSwBR8JTZWZ... | 467320697 | 1,560 lam | Finalized |
| #4 | U8d7rrk4PSuR... | 467320750 | 2,410 lam | Finalized |
| #5 | 5QaKer3LG2JT... | 467320803 | 2,127 lam | Finalized |
| #6 (FAULT) | UChGayLRtJu8... | 467321092 | 2,979 lam | Finalized |
| #7 | 2vFfE37URPev... | 467321139 | 10,000 lam | Finalized |
| #8 | 5QWqUECKTdJi... | 467321191 | 10,000 lam | Finalized |
| #9 | 4QTonfVf2P2e... | 467321241 | 118,571 lam | Finalized |
| #10 | 5RjsKarjDcvh... | 467321296 | 74,185 lam | Finalized |

Wallet: `BqEjkcszfUsJ6VuYa2kAqnnCE2Q1XHu6mxbjGxq1fZni`
Success rate: 100% | Avg confirmation: 1844ms | Total tips: 223,832 lamports

Verify any signature at: `https://explorer.solana.com/tx/<signature>?cluster=devnet`

---

## Additional Outputs

### AGENT_MEMORY.md
Auto-generated after every run. Contains:
- Run summary table (success rate, tips, slots, AI interventions)
- Tip behaviour analysis (range, escalation count, avg confidence)
- Network patterns detected (dominant congestion, avg confirmation delta)
- Sample agent reasoning excerpts
- Recommendation for next run — generated by Groq summarising the entire run

### LIVE_DASHBOARD.html
A self-contained static dashboard. Open in browser, drop `lifecycle.json`:
- Stat cards: success rate, total tips, avg confirmation, AI interventions
- Tip distribution bar chart across all 10 transactions
- Expandable transaction timeline cards showing:
  - Full lifecycle stage timestamps
  - Tip trail bar chart per transaction
  - Agent decision cards with confidence bar and Groq's reasoning

No server, no dependencies, no setup. Works offline.

---

## Architecture Document

### System Overview

The Solana Smart Transaction Stack is a TypeScript backend system designed around three core principles: **no synthetic data**, **AI-driven decisions**, and **honest infrastructure choices**. Every slot number, timestamp, and transaction signature in the output is real and externally verifiable.

The system operates as a sequential pipeline: transactions are built, submitted as Jito bundles, polled for lifecycle state via Helius RPC (with Yellowstone gRPC slot stream as a real-time signal layer), and on failure, analyzed by a Groq AI agent that makes the sole retry decision. No hardcoded retry thresholds, no static tip values, and no simulated confirmations exist anywhere in the codebase.

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        index.ts (Orchestrator)                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────┐  │
│  │ tips.ts  │  │ jito.ts  │  │tracker.ts│  │  reasoner.ts   │  │
│  │Jito tip  │  │Jito Block│  │lifecycle │  │  Groq API      │  │
│  │floor API │  │Engine    │  │state     │  │  llama3-70b    │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬─────────┘  │
│       │              │              │                │            │
│  ┌────▼──────────────▼──────────────▼────────────────▼─────────┐ │
│  │          poller.ts (Helius RPC — primary lifecycle)          │ │
│  │          geyser.ts (SolInfra gRPC — slot stream signal)      │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌──────────────────┐    ┌──────────────────────────────────────┐ │
│  │ agentMemory.ts   │    │ LIVE_DASHBOARD.html                  │ │
│  │ AGENT_MEMORY.md  │    │ lifecycle.json visualizer            │ │
│  └──────────────────┘    └──────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                    Solana Devnet (Helius RPC)
                    Jito devnet block engine
                    SolInfra Yellowstone gRPC
                    Groq API (llama3-70b-8192)
                    Jito tip floor API
```

### Where Hardcoded Logic Ends and AI Begins

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

**Helius over other RPC providers:** Helius free tier provides generous rate limits on devnet and reliable `getSignatureStatuses` support.

**SolInfra for Yellowstone gRPC:** SolInfra provides free-tier Yellowstone gRPC access specifically for Superteam Nigeria bounty builders. The `geyser.ts` component connects to `fra.grpc.solinfra.dev:443` for real-time slot streaming.

**Jito bundles over standard transactions:** Jito bundles provide atomicity and priority ordering — critical for MEV protection and predictable inclusion in production.

**Groq over OpenAI for the agent:** Sub-second inference for structured JSON outputs. For an infrastructure agent that must make decisions mid-transaction pipeline, latency matters.

**TypeScript over Rust:** The @solana/web3.js ecosystem is mature and the Jito TypeScript SDK is well-maintained. For an infrastructure system where developer velocity matters, TypeScript is the right choice.

---

*Made by TJS Code — Olatunde Olabanjo*
*Superteam Nigeria Advanced Infrastructure Challenge*