// ============================================================
// smart-tx-stack — src/ingestion/poller.ts
// Helius RPC polling + network context provider
// Made by TJS Code
// ============================================================

import {
  Connection,
  PublicKey,
  BlockhashWithExpiryBlockHeight,
} from "@solana/web3.js";
import { TransactionState, NetworkContext, CongestionLevel } from "../types";

// ── Constants ────────────────────────────────────────────────
const POLL_INTERVAL_MS = 1500;       // poll every 1.5 s
const TIMEOUT_MS       = 90_000;     // 90 s hard timeout
const MAX_BACKOFF_MS   = 15_000;     // cap exponential backoff
const TIP_CACHE_TTL_MS = 30_000;     // cache tip floor 30 s

// ── Types ────────────────────────────────────────────────────
export type StateChangeCallback = (
  signature: string,
  newState: TransactionState,
  slot: number | null,
  timestamp: number,
) => void;

interface PollResult {
  finalState: TransactionState;
  slot: number | null;
  timedOut: boolean;
}

interface SlotTimestamp {
  slot: number;
  ts: number;
}

// ── Internal state shared across polls ──────────────────────
const recentConfirmationDeltas: number[] = []; // ms between processed→confirmed
const recentFailures: boolean[]          = []; // true = failed, false = success
const MAX_RECENT = 20;                         // rolling window size

function recordDelta(ms: number): void {
  recentConfirmationDeltas.push(ms);
  if (recentConfirmationDeltas.length > MAX_RECENT) {
    recentConfirmationDeltas.shift();
  }
}

function recordOutcome(failed: boolean): void {
  recentFailures.push(failed);
  if (recentFailures.length > MAX_RECENT) recentFailures.shift();
}

// ── Helper: map RPC confirmationStatus to TransactionState ──
function mapCommitment(
  status: string | null | undefined,
): TransactionState | null {
  switch (status) {
    case "processed":   return TransactionState.Processed;
    case "confirmed":   return TransactionState.Confirmed;
    case "finalized":   return TransactionState.Finalized;
    default:            return null;
  }
}

// ── Helper: classify congestion from recent blockhash age ───
function classifyCongestion(
  avgMs: number,
  failureRate: number,
): CongestionLevel {
  if (failureRate > 0.4 || avgMs > 15_000) return "CRITICAL";
  if (failureRate > 0.2 || avgMs > 8_000)  return "HIGH";
  if (failureRate > 0.1 || avgMs > 4_000)  return "MEDIUM";
  return "LOW";
}

// ── Core: poll until finalized / failed / timed-out ─────────
export async function pollTransactionStatus(
  connection: Connection,
  signature: string,
  onStateChange: StateChangeCallback,
): Promise<PollResult> {
  const startTs  = Date.now();
  let lastState: TransactionState | null = null;
  let backoffMs  = POLL_INTERVAL_MS;
  let processedTs: number | null = null;
  let slotLanded: number | null = null;

  console.log(`[POLLER] Starting poll for sig: ${signature.slice(0, 12)}...`);

  while (true) {
    const elapsed = Date.now() - startTs;

    // ── Hard timeout ─────────────────────────────────────────
    if (elapsed >= TIMEOUT_MS) {
      console.warn(
        `[POLLER] TIMEOUT after ${elapsed}ms — sig: ${signature.slice(0, 12)}...`,
      );
      recordOutcome(true);
      onStateChange(signature, TransactionState.Failed, null, Date.now());
      return { finalState: TransactionState.Failed, slot: slotLanded, timedOut: true };
    }

    try {
      const responses = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      });

      const status = responses.value[0];

      // RPC returned null — tx not yet visible, keep waiting
      if (!status) {
        await sleep(backoffMs);
        continue;
      }

      // RPC returned an error
      if (status.err) {
        const errStr = JSON.stringify(status.err);
        console.error(`[POLLER] TX error — sig: ${signature.slice(0, 12)}... err: ${errStr}`);
        recordOutcome(true);
        onStateChange(signature, TransactionState.Failed, status.slot ?? null, Date.now());
        return {
          finalState: TransactionState.Failed,
          slot: status.slot ?? null,
          timedOut: false,
        };
      }

      const currentState = mapCommitment(status.confirmationStatus);
      const currentSlot  = status.slot ?? null;

      if (currentSlot !== null) slotLanded = currentSlot;

      if (currentState && currentState !== lastState) {
        const now = Date.now();

        // Track processed→confirmed delta for congestion model
        if (currentState === TransactionState.Processed) {
          processedTs = now;
        }
        if (currentState === TransactionState.Confirmed && processedTs !== null) {
          const delta = now - processedTs;
          recordDelta(delta);
          console.log(
            `[POLLER] sig: ${signature.slice(0, 12)}... state: Confirmed` +
            ` slot: ${currentSlot} delta: ${delta}ms`,
          );
        } else {
          console.log(
            `[POLLER] sig: ${signature.slice(0, 12)}... state: ${currentState}` +
            ` slot: ${currentSlot}`,
          );
        }

        onStateChange(signature, currentState, currentSlot, now);
        lastState = currentState;

        // Reset backoff on successful progress
        backoffMs = POLL_INTERVAL_MS;
      }

      // Terminal state — stop polling
      if (
        currentState === TransactionState.Finalized ||
        currentState === TransactionState.Failed
      ) {
        recordOutcome(currentState === TransactionState.Failed);
        return {
          finalState: currentState,
          slot: slotLanded,
          timedOut: false,
        };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[POLLER] RPC error (backing off ${backoffMs}ms): ${msg}`);

      // Exponential backoff on RPC errors
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }

    await sleep(backoffMs);
  }
}

// ── Network context builder ──────────────────────────────────
export async function getNetworkContext(
  connection: Connection,
): Promise<NetworkContext> {
  let currentSlot = 0;

  try {
    currentSlot = await connection.getSlot("confirmed");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[POLLER] getSlot failed: ${msg}`);
    // Proceed with 0 — callers must handle this gracefully
  }

  const avgMs =
    recentConfirmationDeltas.length > 0
      ? recentConfirmationDeltas.reduce((a, b) => a + b, 0) /
        recentConfirmationDeltas.length
      : 0;

  const failureRate =
    recentFailures.length > 0
      ? recentFailures.filter(Boolean).length / recentFailures.length
      : 0;

  const congestion = classifyCongestion(avgMs, failureRate);

  console.log(
    `[POLLER] NetworkContext — slot: ${currentSlot}` +
    ` avgConfirm: ${avgMs.toFixed(0)}ms` +
    ` failRate: ${(failureRate * 100).toFixed(1)}%` +
    ` congestion: ${congestion}`,
  );

  return {
    current_slot: currentSlot,
    recent_avg_confirmation_ms: Math.round(avgMs),
    recent_failure_rate: parseFloat(failureRate.toFixed(4)),
    congestion_level: congestion,
  };
}

// ── Utility: fetch and validate a fresh blockhash ────────────
export async function getFreshBlockhash(
  connection: Connection,
): Promise<BlockhashWithExpiryBlockHeight> {
  const bh = await connection.getLatestBlockhash("confirmed");
  console.log(
    `[POLLER] Fresh blockhash: ${bh.blockhash.slice(0, 12)}...` +
    ` lastValidBlockHeight: ${bh.lastValidBlockHeight}`,
  );
  return bh;
}

// ── Utility: simple promise-based sleep ─────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
