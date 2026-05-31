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

export interface LifecycleEntry {
  /** Base58-encoded transaction signature */
  signature: string;

  /** ISO 8601 timestamp when tx was submitted */
  submitted_at: string;

  /** ISO 8601 timestamp when tx reached 'processed' commitment — null until reached */
  processed_at: string | null;

  /** ISO 8601 timestamp when tx reached 'confirmed' commitment — null until reached */
  confirmed_at: string | null;

  /** ISO 8601 timestamp when tx reached 'finalized' commitment — null until reached */
  finalized_at: string | null;

  /** Slot number at submission time */
  slot_submitted: number;

  /** Slot number when tx landed on-chain — null if not yet landed */
  slot_landed: number | null;

  /** Jito tip paid in lamports */
  tip_paid_lamports: number;

  /** Failure type if tx failed */
  failure_type?: TransactionFailure;

  /** Full AI reasoning from Groq agent — populated on retry decisions */
  ai_decision?: string;

  /** How many times this tx has been retried */
  retry_count: number;

  /** Final resolved state */
  final_state: TransactionState;

  /** Jito bundle ID returned at submission */
  bundle_id?: string;
}

export interface AgentDecision {
  /** Whether the agent recommends retrying this transaction */
  should_retry: boolean;

  /** Recommended tip in lamports for the retry attempt */
  new_tip_lamports: number;

  /** Agent's full reasoning string */
  reason: string;

  /**
   * Confidence score 0–1.
   * If confidence_score < 0.6, retry must NOT proceed regardless of should_retry.
   */
  confidence_score: number;
}

export interface NetworkContext {
  /** Current slot on the network */
  current_slot: number;

  /**
   * Rolling average of recent processed→confirmed deltas in milliseconds.
   * 0 if no data yet.
   */
  recent_avg_confirmation_ms: number;

  /**
   * Fraction of recent transactions that failed (0.0 – 1.0).
   * 0 if no data yet.
   */
  recent_failure_rate: number;

  /** Human-readable congestion classification */
  congestion_level: CongestionLevel;
}

export interface BundleSubmissionResult {
  /** Jito bundle UUID */
  bundle_id: string;

  /** Slot at which the bundle was submitted */
  submission_slot: number;

  /** Whether submission call succeeded (does NOT mean tx landed) */
  success: boolean;

  /** Error message if success = false */
  error?: string;

  /** Whether we fell back to standard (non-Jito) submission */
  used_fallback: boolean;
}

export interface TipFloorData {
  /** 25th percentile tip in lamports */
  p25: number;
  /** 50th percentile tip in lamports */
  p50: number;
  /** 75th percentile tip in lamports */
  p75: number;
  /** 95th percentile tip in lamports */
  p95: number;
  /** Epoch timestamp (ms) when this data was fetched */
  fetched_at: number;
}

export interface SystemSummary {
  total_transactions: number;
  successful: number;
  failed: number;
  success_rate_pct: number;
  avg_confirmation_ms: number;
  total_tips_paid_lamports: number;
  ai_interventions: number;
  ai_approved_retries: number;
  ai_rejected_retries: number;
}
