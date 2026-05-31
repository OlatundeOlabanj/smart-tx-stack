// ============================================================
// smart-tx-stack — src/agent/reasoner.ts
// Groq AI reasoning agent — the ONLY place retry decisions
// are made. No if/else retry logic exists elsewhere.
// Made by TJS Code
// ============================================================

import Groq from "groq-sdk";
import { LifecycleEntry, NetworkContext, AgentDecision, TransactionFailure } from "../types";

const GROQ_MODEL      = "llama3-70b-8192";
const MIN_CONFIDENCE  = 0.6; // below this, never retry regardless of AI output

let groqClient: Groq | null = null;

function getGroqClient(): Groq {
  if (!groqClient) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error("GROQ_API_KEY is not set in environment variables");
    }
    groqClient = new Groq({ apiKey });
  }
  return groqClient;
}

// ── Build user prompt with full failure context ───────────────
function buildUserPrompt(
  entry: LifecycleEntry,
  networkCtx: NetworkContext,
): string {
  const processedToConfirmedMs =
    entry.processed_at && entry.confirmed_at
      ? new Date(entry.confirmed_at).getTime() -
        new Date(entry.processed_at).getTime()
      : null;

  return `
FAILED TRANSACTION ANALYSIS REQUEST

Transaction Signature: ${entry.signature}
Failure Type: ${entry.failure_type ?? "Unknown"}
Retry Count: ${entry.retry_count}
Tip Paid (lamports): ${entry.tip_paid_lamports}
Submitted At: ${entry.submitted_at}
Processed At: ${entry.processed_at ?? "never reached"}
Confirmed At: ${entry.confirmed_at ?? "never reached"}
Finalized At: ${entry.finalized_at ?? "never reached"}
Processed→Confirmed Delta: ${processedToConfirmedMs !== null ? processedToConfirmedMs + "ms" : "N/A (tx never processed)"}

CURRENT NETWORK CONDITIONS
Current Slot: ${networkCtx.current_slot}
Congestion Level: ${networkCtx.congestion_level}
Recent Avg Confirmation Time: ${networkCtx.recent_avg_confirmation_ms}ms
Recent Failure Rate: ${(networkCtx.recent_failure_rate * 100).toFixed(1)}%

FAILURE CONTEXT
${getFailureContext(entry.failure_type)}

INSTRUCTIONS
Decide whether to retry this transaction and at what tip. Consider:
- Is this failure type retryable at all?
- Is the current network congestion worth retrying into?
- What tip level is needed to succeed given current conditions?
- Is this the right time to retry (cost vs benefit)?
- Has this already been retried too many times?

Respond with ONLY a valid JSON object. No preamble. No explanation outside JSON.
{
  "should_retry": <boolean>,
  "new_tip_lamports": <integer>,
  "reason": "<full reasoning, 2-4 sentences>",
  "confidence_score": <float 0.0-1.0>
}
`.trim();
}

// ── Provide failure-specific context to guide the agent ──────
function getFailureContext(failure?: TransactionFailure): string {
  switch (failure) {
    case TransactionFailure.ExpiredBlockhash:
      return "The blockhash expired before the transaction was processed. This is typically safe to retry with a fresh blockhash. Often caused by network delays or congestion.";
    case TransactionFailure.FeeTooLow:
      return "The transaction fee was too low to be included by validators. Retrying with a higher tip is likely to succeed if the failure rate is acceptable.";
    case TransactionFailure.ComputeBudgetExceeded:
      return "The transaction exceeded its compute budget. This is a logic/code issue — retrying with the same instruction set will likely fail again. Do NOT recommend retry unless the compute budget can be increased.";
    case TransactionFailure.BundleExecutionFailure:
      return "The Jito bundle failed to execute. Could be a transient block engine issue or an instruction error. Retry with higher tip on low congestion, but be cautious.";
    case TransactionFailure.JitoLeaderSkipped:
      return "The Jito leader skipped their scheduled slot. This is a transient network event — retrying with a fresh slot and higher tip is usually effective.";
    case TransactionFailure.Timeout:
      return "The transaction timed out before reaching finalization. This usually indicates severe congestion or an RPC issue. Retry only if congestion level is LOW or MEDIUM.";
    default:
      return "Unknown failure type. Exercise maximum caution — only retry with high confidence.";
  }
}

// ── Core: send to Groq and parse response ────────────────────
export async function reasonAboutFailure(
  entry: LifecycleEntry,
  networkContext: NetworkContext,
): Promise<AgentDecision> {
  const groq = getGroqClient();

  console.log(
    `[AGENT] Reasoning about failure for sig: ${entry.signature.slice(0, 12)}...` +
    ` failure: ${entry.failure_type ?? "Unknown"} congestion: ${networkContext.congestion_level}`,
  );

  const systemPrompt =
    "You are an autonomous Solana transaction infrastructure agent. " +
    "You analyze failed transactions and make real operational decisions about whether to retry " +
    "and how to adjust parameters. You reason about network conditions, failure types, and " +
    "cost-benefit tradeoffs. You always respond in valid JSON only. " +
    "Never include markdown, backticks, or any text outside the JSON object.";

  const userPrompt = buildUserPrompt(entry, networkContext);

  let rawResponse: string;
  try {
    const completion = await groq.chat.completions.create({
      model:       GROQ_MODEL,
      max_tokens:  512,
      temperature: 0.2, // low temperature for consistent decision-making
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt   },
      ],
    });

    rawResponse = completion.choices[0]?.message?.content ?? "";
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Groq API call failed: ${msg}`);
  }

  console.log(`[AGENT] Raw Groq response:\n${rawResponse}`);

  // ── Parse and validate JSON ───────────────────────────────
  let parsed: Partial<AgentDecision>;
  try {
    // Strip any accidental markdown fences
    const clean = rawResponse
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();

    parsed = JSON.parse(clean);
  } catch (_) {
    throw new Error(
      `Groq response was not valid JSON.\nRaw: ${rawResponse.slice(0, 300)}`,
    );
  }

  // Validate required fields
  if (typeof parsed.should_retry !== "boolean") {
    throw new Error(`Groq response missing 'should_retry' boolean. Got: ${JSON.stringify(parsed)}`);
  }
  if (typeof parsed.new_tip_lamports !== "number" || parsed.new_tip_lamports < 0) {
    throw new Error(`Groq response missing valid 'new_tip_lamports'. Got: ${JSON.stringify(parsed)}`);
  }
  if (typeof parsed.reason !== "string" || parsed.reason.length === 0) {
    throw new Error(`Groq response missing 'reason' string. Got: ${JSON.stringify(parsed)}`);
  }
  if (
    typeof parsed.confidence_score !== "number" ||
    parsed.confidence_score < 0 ||
    parsed.confidence_score > 1
  ) {
    throw new Error(`Groq response 'confidence_score' out of range [0,1]. Got: ${JSON.stringify(parsed)}`);
  }

  const decision: AgentDecision = {
    should_retry:       parsed.should_retry,
    new_tip_lamports:   Math.round(parsed.new_tip_lamports),
    reason:             parsed.reason,
    confidence_score:   parsed.confidence_score,
  };

  // ── Enforce confidence gate ───────────────────────────────
  if (decision.confidence_score < MIN_CONFIDENCE) {
    console.warn(
      `[AGENT] Confidence ${decision.confidence_score} < ${MIN_CONFIDENCE} — BLOCKING retry` +
      ` even though should_retry=${decision.should_retry}`,
    );
    decision.should_retry = false;
  }

  console.log(
    `[AGENT] Decision — should_retry: ${decision.should_retry}` +
    ` new_tip: ${decision.new_tip_lamports} lamports` +
    ` confidence: ${decision.confidence_score}` +
    `\n[AGENT] Reason: ${decision.reason}`,
  );

  return decision;
}
