// ============================================================
// smart-tx-stack — src/types/index.ts
// Shared TypeScript interfaces and enums
// Made by TJS Code
// ============================================================

export enum TransactionState {
  Submitted = "Submitted",
  Processed = "Processed",
  Confirmed = "Confirmed",
  Finalized = "Finalized",
  Failed = "Failed",
}

export enum TransactionFailure {
  ExpiredBlockhash = "ExpiredBlockhash",
  FeeTooLow = "FeeTooLow",
  ComputeBudgetExceeded = "ComputeBudgetExceeded",
  BundleExecutionFailure = "BundleExecutionFailure",
  JitoLeaderSkipped = "JitoLeaderSkipped",
  Timeout = "Timeout",
  Unknown = "Unknown",
}

export type CongestionLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type UrgencyLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

// ── NEW: one entry in the tip escalation trail ────────────────
export interface TipTrailEntry {
  attempt:        number;
  tip_lamports:   number;
  congestion_level: CongestionLevel;
  percentile:     "p25" | "p50" | "p75" | "p95";
  submitted_at:   string;
}

// ── NEW: structured agent decision stored per-tx ─────────────
export interface AgentDecisionRecord {
  triggered_at:   string;
  failure_type:   string;
  network_context: {
    current_slot:            number;
    avg_confirmation_ms:     number;
    congestion_level:        CongestionLevel;
    recent_failure_rate:     number;
  };
  groq_response: {
    should_retry:      boolean;
    new_tip_lamports:  number;
    reason:            string;
    confidence_score:  number;
  };
  gate_passed: boolean; // true if confidence >= 0.6 AND should_retry = true
}

export interface LifecycleEntry {
  signature:         string;
  submitted_at:      string;
  processed_at:      string | null;
  confirmed_at:      string | null;
  finalized_at:      string | null;
  slot_submitted:    number;
  slot_landed:       number | null;
  tip_paid_lamports: number;
  failure_type?:     TransactionFailure;
  ai_decision?:      string;           // kept for backwards compat
  agent_decisions?:  AgentDecisionRecord[]; // NEW: full structured log
  tip_trail?:        TipTrailEntry[];        // NEW: tip escalation history
  retry_count:       number;
  final_state:       TransactionState;
  bundle_id?:        string;
}

export interface AgentDecision {
  should_retry:      boolean;
  new_tip_lamports:  number;
  reason:            string;
  confidence_score:  number;
}

export interface NetworkContext {
  current_slot:               number;
  recent_avg_confirmation_ms: number;
  recent_failure_rate:        number;
  congestion_level:           CongestionLevel;
}

export interface BundleSubmissionResult {
  bundle_id:       string;
  submission_slot: number;
  success:         boolean;
  error?:          string;
  used_fallback:   boolean;
}

export interface TipFloorData {
  p25:        number;
  p50:        number;
  p75:        number;
  p95:        number;
  fetched_at: number;
}

export interface SystemSummary {
  total_transactions:       number;
  successful:               number;
  failed:                   number;
  success_rate_pct:         number;
  avg_confirmation_ms:      number;
  total_tips_paid_lamports: number;
  ai_interventions:         number;
  ai_approved_retries:      number;
  ai_rejected_retries:      number;
}
