// ============================================================
// smart-tx-stack — src/ingestion/leaderSchedule.ts
// Solana leader schedule reader — detects the current leader
// window and advises on optimal bundle submission timing.
// Satisfies bounty requirement: "Detect the correct leader
// window for submission"
// Made by TJS Code
// ============================================================

import { Connection } from "@solana/web3.js";

export interface LeaderWindowInfo {
  current_slot:           number;
  current_leader:         string | null;
  slots_until_next_epoch: number;
  leader_slots_ahead:     number[]; // next N slots where current leader repeats
  recommended_delay_ms:   number;   // 0 if good to submit now
  submission_advice:      "SUBMIT_NOW" | "HOLD" | "UNKNOWN";
  reason:                 string;
}

// How many upcoming slots to scan for leader repeats
const LOOKAHEAD_SLOTS = 20;

// If we are in the last N slots of a leader's 4-slot window,
// hold until the next window rather than submitting late.
const MIN_SLOTS_REMAINING_IN_WINDOW = 1;

// Slot duration estimate on devnet (ms)
const SLOT_DURATION_MS = 400;

// ── Fetch current slot and leader identity ────────────────────
async function getCurrentSlotAndLeader(
  connection: Connection,
): Promise<{ slot: number; leader: string | null }> {
  const slot = await connection.getSlot("confirmed").catch(() => 0);
  let leader: string | null = null;
  try {
    // getSlotLeader returns the leader's validator identity pubkey
    leader = (await (connection as any).getSlotLeader("confirmed")) ?? null;
  } catch {
    // getSlotLeader may not exist on all RPC endpoints — degrade gracefully
    leader = null;
  }
  return { slot, leader };
}

// ── Fetch leader schedule for the current epoch ───────────────
// Returns a map of { validatorPubkey: slotIndices[] } for the epoch
async function fetchLeaderSchedule(
  connection: Connection,
  slot: number,
): Promise<Record<string, number[]> | null> {
  try {
    const schedule = await (connection as any).getLeaderSchedule(slot);
    return schedule ?? null;
  } catch {
    return null;
  }
}

// ── Find which validator is the leader for a given slot index ─
function leaderForSlotIndex(
  schedule: Record<string, number[]>,
  slotIndex: number,
): string | null {
  for (const [validator, slots] of Object.entries(schedule)) {
    if (slots.includes(slotIndex)) return validator;
  }
  return null;
}

// ── Get epoch info to convert absolute slot → slot-in-epoch ──
async function getEpochInfo(
  connection: Connection,
): Promise<{ absoluteSlot: number; slotIndex: number; slotsInEpoch: number } | null> {
  try {
    const info = await connection.getEpochInfo("confirmed");
    return {
      absoluteSlot: info.absoluteSlot,
      slotIndex:    info.slotIndex,
      slotsInEpoch: info.slotsInEpoch,
    };
  } catch {
    return null;
  }
}

// ── Main export: analyse the leader window ────────────────────
export async function detectLeaderWindow(
  connection: Connection,
): Promise<LeaderWindowInfo> {
  console.log("[LEADER] Fetching leader schedule...");

  const epochInfo = await getEpochInfo(connection);
  if (!epochInfo) {
    console.warn("[LEADER] Could not fetch epoch info — submitting without leader timing");
    return {
      current_slot:           0,
      current_leader:         null,
      slots_until_next_epoch: 0,
      leader_slots_ahead:     [],
      recommended_delay_ms:   0,
      submission_advice:      "UNKNOWN",
      reason:                 "Could not fetch epoch info — RPC fallback",
    };
  }

  const { absoluteSlot, slotIndex, slotsInEpoch } = epochInfo;
  const slotsUntilEpochEnd = slotsInEpoch - slotIndex;

  // Position within current 4-slot leader window (0-3)
  const posInWindow       = slotIndex % 4;
  const slotsLeftInWindow = 4 - posInWindow;

  // Fetch the full leader schedule
  const schedule = await fetchLeaderSchedule(connection, absoluteSlot);
  const { leader: currentLeader } = await getCurrentSlotAndLeader(connection);

  if (!schedule) {
    console.warn("[LEADER] Leader schedule unavailable — submitting now");
    return {
      current_slot:           absoluteSlot,
      current_leader:         currentLeader,
      slots_until_next_epoch: slotsUntilEpochEnd,
      leader_slots_ahead:     [],
      recommended_delay_ms:   0,
      submission_advice:      "SUBMIT_NOW",
      reason:                 "Leader schedule unavailable — defaulting to immediate submission",
    };
  }

  // Find upcoming slots for the current leader (look LOOKAHEAD_SLOTS ahead)
  const leaderSlotsAhead: number[] = [];
  if (currentLeader) {
    const leaderSlots = schedule[currentLeader] ?? [];
    for (let i = slotIndex + 1; i <= slotIndex + LOOKAHEAD_SLOTS && i < slotsInEpoch; i++) {
      if (leaderSlots.includes(i)) {
        leaderSlotsAhead.push(absoluteSlot + (i - slotIndex));
      }
    }
  }

  // Decision logic:
  // Solana assigns 4 consecutive slots to each leader.
  // If we are in slot 3 of 4 (posInWindow === 3), the leader
  // window is almost over. Better to wait for the next window
  // to avoid the bundle being dropped when the leader rotates.
  let advice: "SUBMIT_NOW" | "HOLD";
  let reason: string;
  let delayMs = 0;

  if (slotsLeftInWindow <= MIN_SLOTS_REMAINING_IN_WINDOW) {
    // Last slot of window — wait for the next 4-slot window
    delayMs = slotsLeftInWindow * SLOT_DURATION_MS + 50;
    advice  = "HOLD";
    reason  =
      `Currently slot ${posInWindow + 1}/4 in leader window — ` +
      `${slotsLeftInWindow} slot(s) remain. ` +
      `Holding ${delayMs}ms for next leader window to avoid late-window drop.`;
  } else {
    advice = "SUBMIT_NOW";
    reason =
      `Slot ${posInWindow + 1}/4 in leader window — ` +
      `${slotsLeftInWindow} slot(s) remain. ` +
      `Good window for bundle submission.`;
  }

  console.log(`[LEADER] Slot: ${absoluteSlot} | Leader: ${currentLeader?.slice(0, 12) ?? "unknown"}...`);
  console.log(`[LEADER] Window position: ${posInWindow + 1}/4 | Advice: ${advice}`);
  console.log(`[LEADER] ${reason}`);

  return {
    current_slot:           absoluteSlot,
    current_leader:         currentLeader,
    slots_until_next_epoch: slotsUntilEpochEnd,
    leader_slots_ahead:     leaderSlotsAhead,
    recommended_delay_ms:   delayMs,
    submission_advice:      advice,
    reason,
  };
}

// ── Convenience: wait if HOLD is recommended ─────────────────
export async function waitForLeaderWindow(
  connection: Connection,
): Promise<LeaderWindowInfo> {
  const info = await detectLeaderWindow(connection);

  if (info.submission_advice === "HOLD" && info.recommended_delay_ms > 0) {
    console.log(`[LEADER] Holding ${info.recommended_delay_ms}ms for optimal window...`);
    await new Promise((r) => setTimeout(r, info.recommended_delay_ms));
    // Re-check after wait
    const updated = await detectLeaderWindow(connection);
    return updated;
  }

  return info;
}
