// ============================================================
// smart-tx-stack — src/execution/tips.ts
// Dynamic tip calculator using live Jito tip floor API
// Made by TJS Code
// ============================================================

import { TipFloorData, UrgencyLevel } from "../types";

const JITO_TIP_FLOOR_URL = "https://bundles.jito.wtf/api/v1/bundles/tip_floor";
const CACHE_TTL_MS       = 30_000; // 30 seconds

// Fallback values (lamports) used only when Jito API is unreachable
const FALLBACK_TIPS: Record<UrgencyLevel, number> = {
  LOW:      1_000,
  MEDIUM:   5_000,
  HIGH:    10_000,
  CRITICAL: 50_000,
};

let tipCache: TipFloorData | null = null;

// ── Fetch tip floor from Jito API with caching ───────────────
async function fetchTipFloor(): Promise<TipFloorData> {
  const now = Date.now();

  if (tipCache && now - tipCache.fetched_at < CACHE_TTL_MS) {
    console.log("[TIPS] Using cached tip floor data");
    return tipCache;
  }

  console.log("[TIPS] Fetching live tip floor from Jito API...");

  const res = await fetch(JITO_TIP_FLOOR_URL, {
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(8_000),
  });

  if (!res.ok) {
    throw new Error(`Jito tip floor API returned ${res.status}: ${res.statusText}`);
  }

  const raw = await res.json();

  // Jito returns an array — take the first element
  // Shape: [{ time, landed_tips: { p25, p50, p75, p95, p99, ema_landed_tips } }]
  const entry = Array.isArray(raw) ? raw[0] : raw;

  if (!entry) {
    throw new Error(`Unexpected Jito tip floor response shape: ${JSON.stringify(raw)}`);
  }

  const toLamports = (v: number) => v < 1 ? Math.round(v * 1_000_000_000) : Math.round(v);

  tipCache = {
    p25:        toLamports(entry.landed_tips_25th_percentile ?? entry.landed_tips?.p25 ?? 0.000001),
    p50:        toLamports(entry.landed_tips_50th_percentile ?? entry.landed_tips?.p50 ?? 0.000005),
    p75:        toLamports(entry.landed_tips_75th_percentile ?? entry.landed_tips?.p75 ?? 0.000010),
    p95:        toLamports(entry.landed_tips_95th_percentile ?? entry.landed_tips?.p95 ?? 0.000050),
    fetched_at: now,
  };

  console.log(
    `[TIPS] Live tip floor — p25: ${tipCache.p25} p50: ${tipCache.p50}` +
    ` p75: ${tipCache.p75} p95: ${tipCache.p95} lamports`,
  );

  return tipCache;
}

// ── Public: calculate dynamic tip by urgency ─────────────────
export async function calculateDynamicTip(urgency: UrgencyLevel): Promise<number> {
  try {
    const floor = await fetchTipFloor();

    const tip = {
      LOW:      floor.p25,
      MEDIUM:   floor.p50,
      HIGH:     floor.p75,
      CRITICAL: floor.p95,
    }[urgency];

    // Enforce a minimum of 1000 lamports regardless of API data
    const finalTip = Math.max(tip, 1_000);

    console.log(`[TIPS] urgency=${urgency} → tip=${finalTip} lamports`);
    return finalTip;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[TIPS] Jito API failed — using fallback values. Reason: ${msg}`);

    const fallback = FALLBACK_TIPS[urgency];
    console.warn(`[TIPS] FALLBACK urgency=${urgency} → tip=${fallback} lamports`);
    return fallback;
  }
}

// ── Public: get full cached floor (used by agent for context) ─
export async function getTipFloor(): Promise<TipFloorData> {
  try {
    return await fetchTipFloor();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[TIPS] Could not fetch tip floor for context: ${msg}`);
    return {
      p25:        FALLBACK_TIPS.LOW,
      p50:        FALLBACK_TIPS.MEDIUM,
      p75:        FALLBACK_TIPS.HIGH,
      p95:        FALLBACK_TIPS.CRITICAL,
      fetched_at: Date.now(),
    };
  }
}

// ── Public: invalidate cache (e.g. after failed bundle) ───────
export function invalidateTipCache(): void {
  tipCache = null;
  console.log("[TIPS] Tip cache invalidated");
}
