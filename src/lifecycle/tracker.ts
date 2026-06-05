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
  TipTrailEntry,
  AgentDecisionRecord,
  NetworkContext,
  AgentDecision,
  CongestionLevel,
} from "../types";

const LOG_PATH = path.resolve(process.cwd(), "logs", "lifecycle.json");

const entries = new Map<string, LifecycleEntry>();

function ensureLogDir(): void {
  const dir = path.dirname(LOG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

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
    submitted_at:      new Date().toISOString(),
    processed_at:      null,
    confirmed_at:      null,
    finalized_at:      null,
    slot_submitted:    slotSubmitted,
    slot_landed:       null,
    tip_paid_lamports: tipPaidLamports,
    retry_count:       0,
    final_state:       TransactionState.Submitted,
    bundle_id:         bundleId,
    tip_trail:         [],
    agent_decisions:   [],
  };

  entries.set(signature, entry);
  console.log(`[TRACKER] Created entry for ${signature.slice(0, 12)}... slot: ${slotSubmitted}`);
}

export function updateState(
  signature: string,
  state: TransactionState,
  slot?: number | null,
): void {
  const entry = entries.get(signature);
  if (!entry) {
    console.warn(`[TRACKER] No entry found for sig: ${signature.slice(0, 12)}...`);
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

  if (slot != null && entry.slot_landed === null) entry.slot_landed = slot;

  entries.set(signature, entry);
  console.log(`[TRACKER] ${signature.slice(0, 12)}... → ${state} at ${now}`);
}

// ── NEW: append one step to the tip trail ────────────────────
export function appendTipTrail(
  signature: string,
  tipLamports: number,
  congestionLevel: CongestionLevel,
  percentile: "p25" | "p50" | "p75" | "p95",
): void {
  const entry = entries.get(signature);
  if (!entry) return;
  if (!entry.tip_trail) entry.tip_trail = [];

  const attempt = entry.tip_trail.length + 1;
  entry.tip_trail.push({
    attempt,
    tip_lamports:     tipLamports,
    congestion_level: congestionLevel,
    percentile,
    submitted_at:     new Date().toISOString(),
  });

  entries.set(signature, entry);
  console.log(
    `[TRACKER] Tip trail #${attempt} — ${tipLamports} lamports ` +
    `(${percentile}, congestion: ${congestionLevel})`,
  );
}

// ── NEW: append a full structured agent decision record ───────
export function appendAgentDecision(
  signature: string,
  failureType: string,
  networkCtx: NetworkContext,
  decision: AgentDecision,
): void {
  const entry = entries.get(signature);
  if (!entry) return;
  if (!entry.agent_decisions) entry.agent_decisions = [];

  const gatePassed = decision.confidence_score >= 0.6 && decision.should_retry;

  const record: AgentDecisionRecord = {
    triggered_at:    new Date().toISOString(),
    failure_type:    failureType,
    network_context: {
      current_slot:        networkCtx.current_slot,
      avg_confirmation_ms: networkCtx.recent_avg_confirmation_ms,
      congestion_level:    networkCtx.congestion_level,
      recent_failure_rate: networkCtx.recent_failure_rate,
    },
    groq_response: {
      should_retry:     decision.should_retry,
      new_tip_lamports: decision.new_tip_lamports,
      reason:           decision.reason,
      confidence_score: decision.confidence_score,
    },
    gate_passed: gatePassed,
  };

  entry.agent_decisions.push(record);
  entries.set(signature, entry);

  console.log(
    `[TRACKER] Agent decision recorded — confidence: ${decision.confidence_score} ` +
    `gate_passed: ${gatePassed} new_tip: ${decision.new_tip_lamports} lamports`,
  );
}

export function classifyFailure(errorMessage: string): TransactionFailure {
  const msg = errorMessage.toLowerCase();
  if (msg.includes("blockhash not found") || msg.includes("expired")) return TransactionFailure.ExpiredBlockhash;
  if (msg.includes("insufficient funds") || msg.includes("fee too low")) return TransactionFailure.FeeTooLow;
  if (msg.includes("compute budget") || msg.includes("exceeded compute") || msg.includes("computebudget")) return TransactionFailure.ComputeBudgetExceeded;
  if (msg.includes("bundle") && msg.includes("fail")) return TransactionFailure.BundleExecutionFailure;
  if (msg.includes("leader") && msg.includes("skip")) return TransactionFailure.JitoLeaderSkipped;
  if (msg.includes("timeout") || msg.includes("timed out")) return TransactionFailure.Timeout;
  return TransactionFailure.Unknown;
}

export function recordFailure(
  signature: string,
  failure: TransactionFailure,
  aiDecision?: string,
): void {
  const entry = entries.get(signature);
  if (!entry) return;
  entry.failure_type = failure;
  entry.final_state  = TransactionState.Failed;
  if (aiDecision) entry.ai_decision = aiDecision;
  entries.set(signature, entry);
  console.log(`[TRACKER] Failure recorded — sig: ${signature.slice(0, 12)}... type: ${failure}`);
}

export function incrementRetry(signature: string): void {
  const entry = entries.get(signature);
  if (!entry) return;
  entry.retry_count += 1;
  entries.set(signature, entry);
}

export function recordAiDecision(signature: string, decision: string): void {
  const entry = entries.get(signature);
  if (!entry) return;
  entry.ai_decision = decision;
  entries.set(signature, entry);
}

export function getEntry(signature: string): LifecycleEntry | undefined {
  return entries.get(signature);
}

export function getAllEntries(): LifecycleEntry[] {
  return Array.from(entries.values());
}

export function saveLog(): void {
  ensureLogDir();
  const allEntries = Array.from(entries.values());
  allEntries.sort(
    (a, b) => new Date(a.submitted_at).getTime() - new Date(b.submitted_at).getTime(),
  );

  const payload = {
    generated_at:  new Date().toISOString(),
    total_entries: allEntries.length,
    entries:       allEntries,
  };

  fs.writeFileSync(LOG_PATH, JSON.stringify(payload, null, 2), "utf-8");
  console.log(`[TRACKER] Log saved → ${LOG_PATH} (${allEntries.length} entries)`);
}

export function getSummary(): SystemSummary {
  const all = Array.from(entries.values());

  const successful = all.filter((e) => e.final_state === TransactionState.Finalized).length;
  const failed     = all.filter((e) => e.final_state === TransactionState.Failed).length;

  const deltas: number[] = [];
  for (const e of all) {
    if (e.processed_at && e.confirmed_at) {
      const delta = new Date(e.confirmed_at).getTime() - new Date(e.processed_at).getTime();
      if (delta >= 0) deltas.push(delta);
    }
  }

  const avgConfirmMs =
    deltas.length > 0
      ? Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length)
      : 0;

  const totalTips       = all.reduce((sum, e) => sum + e.tip_paid_lamports, 0);
  const aiInterventions = all.filter((e) => (e.agent_decisions?.length ?? 0) > 0).length;
  const aiApproved      = all.filter(
    (e) => e.agent_decisions?.some((d) => d.gate_passed) ?? false,
  ).length;

  return {
    total_transactions:       all.length,
    successful,
    failed,
    success_rate_pct:         all.length > 0 ? (successful / all.length) * 100 : 0,
    avg_confirmation_ms:      avgConfirmMs,
    total_tips_paid_lamports: totalTips,
    ai_interventions:         aiInterventions,
    ai_approved_retries:      aiApproved,
    ai_rejected_retries:      aiInterventions - aiApproved,
  };
}
