// ============================================================
// smart-tx-stack — src/reports/runHistory.ts
// Reads logs/run_history.json and generates cross-run
// tip intelligence analysis for AGENT_MEMORY.md
// This is a differentiating feature — shows the AI layer
// learning across runs, not just within a single run.
// Made by TJS Code
// ============================================================

import * as fs   from "fs";
import * as path from "path";

const RUN_INDEX = path.resolve(process.cwd(), "logs", "run_history.json");

interface RunEntry {
  run_id:                string;
  run_at:                string;
  total_txns:            number;
  successful:            number;
  failed:                number;
  success_rate_pct:      number;
  avg_confirmation_ms:   number;
  total_tips_lamports:   number;
  ai_interventions:      number;
  ai_approved_retries:   number;
  geyser_confirmed_txns: number;
  slot_range:            string;
}

interface RunHistory {
  total_runs: number;
  runs:       RunEntry[];
}

export function loadRunHistory(): RunHistory | null {
  if (!fs.existsSync(RUN_INDEX)) return null;
  try {
    return JSON.parse(fs.readFileSync(RUN_INDEX, "utf-8")) as RunHistory;
  } catch {
    return null;
  }
}

// ── Generate cross-run tip intelligence section ──────────────
// Returns a markdown string injected into AGENT_MEMORY.md
export function generateTipIntelligenceSection(history: RunHistory | null): string {
  if (!history || history.total_runs < 2) {
    return `
## Cross-Run Tip Intelligence

> First run — no historical baseline yet. Run again to build tip performance history.

*This section will populate automatically after multiple runs.*
`.trim();
  }

  const runs = history.runs.slice(-10); // last 10 runs max
  const avgSuccessRate = runs.reduce((s, r) => s + r.success_rate_pct, 0) / runs.length;
  const avgTipPerRun   = runs.map((r) => Math.round(r.total_tips_lamports / Math.max(r.total_txns, 1)));
  const avgTip         = Math.round(avgTipPerRun.reduce((a, b) => a + b, 0) / avgTipPerRun.length);
  const trend          = runs.length >= 2
    ? runs[runs.length - 1].success_rate_pct - runs[0].success_rate_pct
    : 0;

  const trendLabel = trend > 5 ? "↑ Improving" : trend < -5 ? "↓ Degrading" : "→ Stable";

  const geyserRates = runs.map((r) =>
    r.total_txns > 0
      ? Math.round((r.geyser_confirmed_txns / r.total_txns) * 100)
      : 0,
  );
  const avgGeyserRate = Math.round(
    geyserRates.reduce((a, b) => a + b, 0) / Math.max(geyserRates.length, 1),
  );

  // Tip recommendation based on trend
  let tipRecommendation: string;
  if (avgSuccessRate >= 90 && trend >= 0) {
    tipRecommendation =
      `Current tip strategy is effective (${avgSuccessRate.toFixed(0)}% avg success). ` +
      `Maintain p25–p50 for LOW congestion, escalate to p75+ only on HIGH/CRITICAL.`;
  } else if (avgSuccessRate < 80) {
    tipRecommendation =
      `Success rate below 80% — consider bumping base tip percentile from p25 to p50. ` +
      `Average tip per transaction: ${avgTip.toLocaleString()} lamports may be insufficient.`;
  } else {
    tipRecommendation =
      `Moderate success rate. Watch for patterns: if failures cluster on specific urgency ` +
      `tiers, increase the base percentile for those tiers specifically.`;
  }

  // Build run history table
  const tableRows = runs.map((r) => {
    const date    = r.run_at.slice(0, 10);
    const avgT    = Math.round(r.total_tips_lamports / Math.max(r.total_txns, 1));
    const geyserP = r.total_txns > 0 ? Math.round((r.geyser_confirmed_txns / r.total_txns) * 100) : 0;
    return `| ${date} | ${r.total_txns} | ${r.success_rate_pct.toFixed(0)}% | ${r.avg_confirmation_ms}ms | ${avgT.toLocaleString()} lam | ${geyserP}% gRPC |`;
  }).join("\n");

  return `
## Cross-Run Tip Intelligence

> Analysed across **${history.total_runs}** run(s). Trend: **${trendLabel}** | Avg success: **${avgSuccessRate.toFixed(1)}%**

| Date | TXns | Success | Avg Confirm | Avg Tip | gRPC Confirm |
|------|------|---------|-------------|---------|--------------|
${tableRows}

### Tip Recommendation for Next Run

> ${tipRecommendation}

### gRPC Stream Coverage

Average **${avgGeyserRate}%** of transactions confirmed via Yellowstone gRPC stream across last ${runs.length} run(s). ${
  avgGeyserRate >= 50
    ? "Strong gRPC utilisation — lifecycle data reflects real-time stream confirmation."
    : avgGeyserRate > 0
    ? "Partial gRPC utilisation — some transactions fall back to RPC polling as expected."
    : "gRPC stream confirmation not yet recorded — check SOLINFRA_GRPC_KEY in .env."
}
`.trim();
}
