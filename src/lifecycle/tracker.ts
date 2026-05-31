// ============================================================
// smart-tx-stack — src/lifecycle/tracker.ts
// Real lifecycle tracker — records state transitions + writes
// verifiable proof logs to logs/lifecycle.json
// Made by TJS Code
// ============================================================

import * as fs   from "fs";
import * as path from "path";
import {
  LifecycleEntry,
  TransactionState,
  TransactionFailure,
  SystemSummary,
} from "../types";

const LOG_PATH = path.resolve(process.cwd(), "logs", "lifecycle.json");

// In-memory store keyed by signature
const entries = new Map<string, LifecycleEntry>();

// ── Ensure logs/ directory exists ────────────────────────────
function ensureLogDir(): void {
  const dir = path.dirname(LOG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ── Create a new entry when a tx is first submitted ──────────
export function createEntry(
  signature: string,
  slotSubmitted: number,
  tipPaidLamports: number,
  bundleId?: string,
): void {
  if (entries.has(signature)) {
    console.warn(`[TRACKER] Entry for ${signature.slice(0, 12)}... already exists — skipping create`);
    return;
  }

  const entry: LifecycleEntry = {
    signature,
    submitted_at:     new Date().toISOString(),
    processed_at:     null,
    confirmed_at:     null,
    finalized_at:     null,
    slot_submitted:   slotSubmitted,
    slot_landed:      null,
    tip_paid_lamports: tipPaidLamports,
    retry_count:      0,
    final_state:      TransactionState.Submitted,
    bundle_id:        bundleId,
  };

  entries.set(signature, entry);
  console.log(`[TRACKER] Created entry for ${signature.slice(0, 12)}... slot: ${slotSubmitted}`);
}

// ── Update state with real timestamp when state changes ──────
export function updateState(
  signature: string,
  state: TransactionState,
  slot?: number | null,
): void {
  const entry = entries.get(signature);
  if (!entry) {
    console.warn(`[TRACKER] No entry found for sig: ${signature.slice(0, 12)}... — cannot update state`);
    return;
  }

  const now = new Date().toISOString();

  switch (state) {
    case TransactionState.Processed:
      if (!entry.processed_at) entry.processed_at = now;
      break;
    case TransactionState.Confirmed:
      if (!entry.confirmed_at) entry.confirmed_at = now;
      break;
    case TransactionState.Finalized:
      if (!entry.finalized_at) entry.finalized_at = now;
      entry.final_state = TransactionState.Finalized;
      break;
    case TransactionState.Failed:
      entry.final_state = TransactionState.Failed;
      break;
  }

  if (slot != null && entry.slot_landed === null) {
    entry.slot_landed = slot;
  }

  entries.set(signature, entry);
  console.log(`[TRACKER] ${signature.slice(0, 12)}... → ${state} at ${now}`);
}

// ── Classify Solana error strings into TransactionFailure ────
export function classifyFailure(errorMessage: string): TransactionFailure {
  const msg = errorMessage.toLowerCase();

  if (msg.includes("blockhash not found") || msg.includes("expired")) {
    return TransactionFailure.ExpiredBlockhash;
  }
  if (msg.includes("insufficient funds") || msg.includes("fee too low")) {
    return TransactionFailure.FeeTooLow;
  }
  if (
    msg.includes("compute budget") ||
    msg.includes("exceeded compute") ||
    msg.includes("computebudget")
  ) {
    return TransactionFailure.ComputeBudgetExceeded;
  }
  if (msg.includes("bundle") && msg.includes("fail")) {
    return TransactionFailure.BundleExecutionFailure;
  }
  if (msg.includes("leader") && msg.includes("skip")) {
    return TransactionFailure.JitoLeaderSkipped;
  }
  if (msg.includes("timeout") || msg.includes("timed out")) {
    return TransactionFailure.Timeout;
  }

  return TransactionFailure.Unknown;
}

// ── Record a failure on an entry ─────────────────────────────
export function recordFailure(
  signature: string,
  failure: TransactionFailure,
  aiDecision?: string,
): void {
  const entry = entries.get(signature);
  if (!entry) {
    console.warn(`[TRACKER] No entry for sig: ${signature.slice(0, 12)}... — cannot record failure`);
    return;
  }

  entry.failure_type  = failure;
  entry.final_state   = TransactionState.Failed;
  if (aiDecision) entry.ai_decision = aiDecision;

  entries.set(signature, entry);
  console.log(
    `[TRACKER] Failure recorded — sig: ${signature.slice(0, 12)}...` +
    ` type: ${failure}`,
  );
}

// ── Increment retry count ─────────────────────────────────────
export function incrementRetry(signature: string): void {
  const entry = entries.get(signature);
  if (!entry) return;
  entry.retry_count += 1;
  entries.set(signature, entry);
}

// ── Attach AI decision string to an entry ────────────────────
export function recordAiDecision(signature: string, decision: string): void {
  const entry = entries.get(signature);
  if (!entry) return;
  entry.ai_decision = decision;
  entries.set(signature, entry);
}

// ── Read an entry (for agent reasoning) ──────────────────────
export function getEntry(signature: string): LifecycleEntry | undefined {
  return entries.get(signature);
}

// ── Save all entries to logs/lifecycle.json ───────────────────
export function saveLog(): void {
  ensureLogDir();
  const allEntries = Array.from(entries.values());

  // Sort by submitted_at descending
  allEntries.sort(
    (a, b) =>
      new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime(),
  );

  const payload = {
    generated_at:  new Date().toISOString(),
    total_entries: allEntries.length,
    entries:       allEntries,
  };

  fs.writeFileSync(LOG_PATH, JSON.stringify(payload, null, 2), "utf-8");
  console.log(`[TRACKER] Log saved → ${LOG_PATH} (${allEntries.length} entries)`);
}

// ── Compute system summary ────────────────────────────────────
export function getSummary(): SystemSummary {
  const all = Array.from(entries.values());

  const successful = all.filter(
    (e) => e.final_state === TransactionState.Finalized,
  ).length;

  const failed = all.filter(
    (e) => e.final_state === TransactionState.Failed,
  ).length;

  // Compute avg confirmed→processed delta in ms
  const deltas: number[] = [];
  for (const e of all) {
    if (e.processed_at && e.confirmed_at) {
      const delta =
        new Date(e.confirmed_at).getTime() -
        new Date(e.processed_at).getTime();
      if (delta >= 0) deltas.push(delta);
    }
  }

  const avgConfirmMs =
    deltas.length > 0
      ? Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length)
      : 0;

  const totalTips = all.reduce((sum, e) => sum + e.tip_paid_lamports, 0);

  const aiInterventions  = all.filter((e) => e.ai_decision != null).length;
  const aiApproved       = all.filter(
    (e) => e.ai_decision?.includes('"should_retry":true') ||
           e.ai_decision?.includes('"should_retry": true'),
  ).length;

  return {
    total_transactions:        all.length,
    successful,
    failed,
    success_rate_pct:          all.length > 0 ? (successful / all.length) * 100 : 0,
    avg_confirmation_ms:       avgConfirmMs,
    total_tips_paid_lamports:  totalTips,
    ai_interventions:          aiInterventions,
    ai_approved_retries:       aiApproved,
    ai_rejected_retries:       aiInterventions - aiApproved,
  };
}
