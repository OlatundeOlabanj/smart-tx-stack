// ============================================================
// smart-tx-stack — src/reports/agentMemory.ts
// Auto-generates AGENT_MEMORY.md after each run.
// Summarises what the Groq agent observed, decided, and
// recommends for the next run.
// Made by TJS Code
// ============================================================

import * as fs   from "fs";
import * as path from "path";
import { LifecycleEntry, SystemSummary, TransactionState } from "../types";

const MEMORY_PATH = path.resolve(process.cwd(), "AGENT_MEMORY.md");

export function generateAgentMemory(
  entries: LifecycleEntry[],
  summary: SystemSummary,
  startSlot: number,
): void {
  const runTime  = new Date().toISOString();
  const endSlot  = Math.max(...entries.map((e) => e.slot_landed ?? e.slot_submitted));
  const slotSpan = endSlot - startSlot;

  // ── Tip analysis ─────────────────────────────────────────
  const allTips      = entries.map((e) => e.tip_paid_lamports);
  const minTip       = Math.min(...allTips);
  const maxTip       = Math.max(...allTips);
  const avgTip       = Math.round(allTips.reduce((a, b) => a + b, 0) / allTips.length);
  const tipEscalated = entries.filter(
    (e) => (e.tip_trail?.length ?? 0) > 1,
  ).length;

  // ── Agent decision analysis ───────────────────────────────
  const txWithDecisions = entries.filter((e) => (e.agent_decisions?.length ?? 0) > 0);
  const allDecisions    = txWithDecisions.flatMap((e) => e.agent_decisions ?? []);
  const avgConfidence   =
    allDecisions.length > 0
      ? (
          allDecisions.reduce((sum, d) => sum + d.groq_response.confidence_score, 0) /
          allDecisions.length
        ).toFixed(2)
      : "N/A";
  const gateBlocked     = allDecisions.filter((d) => !d.gate_passed && d.groq_response.should_retry).length;

  // ── Congestion analysis ───────────────────────────────────
  const congestionLevels = allDecisions.map((d) => d.network_context.congestion_level);
  const congestionCounts = congestionLevels.reduce(
    (acc: Record<string, number>, c) => { acc[c] = (acc[c] ?? 0) + 1; return acc; },
    {},
  );
  const dominantCongestion =
    Object.entries(congestionCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "UNKNOWN";

  // ── Failure analysis ──────────────────────────────────────
  const failures = entries.filter((e) => e.final_state === TransactionState.Failed);
  const failureSummary = failures
    .map((e) => `- TX sig \`${e.signature.slice(0, 16)}...\` — ${e.failure_type ?? "Unknown"}`)
    .join("\n") || "- None";

  // ── Agent reasoning excerpts ──────────────────────────────
  const reasoningExcerpts = allDecisions
    .slice(0, 3)
    .map(
      (d, i) =>
        `**Decision ${i + 1}** (${d.failure_type}, confidence: ${d.groq_response.confidence_score})\n` +
        `> "${d.groq_response.reason}"`,
    )
    .join("\n\n");

  // ── Next run recommendation ───────────────────────────────
  let nextRunRecommendation: string;
  if (summary.success_rate_pct === 100 && avgTip < 5000) {
    nextRunRecommendation =
      "Network is stable. p25 tip tier is sufficient unless submitting time-sensitive bundles. " +
      "No congestion issues detected — current configuration is optimal.";
  } else if (summary.success_rate_pct < 80) {
    nextRunRecommendation =
      `Elevated failure rate detected (${summary.success_rate_pct.toFixed(1)}%). ` +
      "Recommend increasing base tip to p50 and enabling automatic tip escalation on first retry. " +
      "Consider reducing TX_COUNT during high congestion windows.";
  } else if (dominantCongestion === "HIGH" || dominantCongestion === "CRITICAL") {
    nextRunRecommendation =
      `Network showed ${dominantCongestion} congestion during this run. ` +
      "Recommend starting at p50 tip floor rather than p25 for the next run. " +
      "Geyser slot stream would provide earlier congestion signals.";
  } else {
    nextRunRecommendation =
      "Network conditions were moderate. Current tip strategy is adequate. " +
      "Monitor tip_trail escalations — if > 30% of transactions escalate, bump base urgency up one tier.";
  }

  // ── Build the markdown ───────────────────────────────────
  const md = `# AGENT_MEMORY.md — Smart TX Stack
> Auto-generated after each run. Do not edit manually.
> Made by TJS Code

---

## Run Summary — ${runTime}

| Metric | Value |
|--------|-------|
| Total Transactions | ${summary.total_transactions} |
| Finalized | ${summary.successful} |
| Failed | ${summary.failed} |
| Success Rate | ${summary.success_rate_pct.toFixed(1)}% |
| Avg Confirmation | ${summary.avg_confirmation_ms}ms |
| Total Tips Paid | ${summary.total_tips_paid_lamports.toLocaleString()} lamports |
| Slot Range | ${startSlot} – ${endSlot} (${slotSpan} slots) |
| AI Interventions | ${summary.ai_interventions} |
| AI Approved Retries | ${summary.ai_approved_retries} |
| AI Rejected Retries | ${summary.ai_rejected_retries} |

---

## Agent Observations

### Tip Behaviour
- Tip range this run: **${minTip.toLocaleString()} – ${maxTip.toLocaleString()} lamports** (avg: ${avgTip.toLocaleString()})
- Transactions that required tip escalation: **${tipEscalated}** of ${summary.total_transactions}
- Avg agent confidence score: **${avgConfidence}** ${Number(avgConfidence) >= 0.8 ? "— high certainty across all decisions" : "— moderate certainty, monitor closely"}
${gateBlocked > 0 ? `- Confidence gate blocked **${gateBlocked}** retry(ies) that the agent initially flagged as retryable` : "- Confidence gate did not block any retries this run"}

### Network Patterns Detected
- Dominant congestion level: **${dominantCongestion}**
- Congestion distribution: ${Object.entries(congestionCounts).map(([k, v]) => `${k}: ${v}×`).join(", ") || "no AI-triggered network reads"}
- Avg processed→confirmed delta: **${summary.avg_confirmation_ms}ms** ${summary.avg_confirmation_ms < 1000 ? "(healthy)" : summary.avg_confirmation_ms < 3000 ? "(moderate)" : "(slow — congestion likely)"}

### Failure Events
${failureSummary}

${reasoningExcerpts ? `### Sample Agent Reasoning\n\n${reasoningExcerpts}` : ""}

---

## Agent Recommendation for Next Run

> "${nextRunRecommendation}"

---

*Generated by Groq llama3-70b-8192 · Smart TX Stack · TJS Code*
`;

  fs.writeFileSync(MEMORY_PATH, md, "utf-8");
  console.log(`[MEMORY] AGENT_MEMORY.md written → ${MEMORY_PATH}`);
}
