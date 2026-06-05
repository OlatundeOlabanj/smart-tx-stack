// ============================================================
// smart-tx-stack — src/index.ts
// Main orchestrator — runs 10 real devnet transactions,
// tracks full lifecycle, injects fault, calls AI agent
// Made by TJS Code
// ============================================================

import "dotenv/config";
import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";

import { pollTransactionStatus, getNetworkContext, getFreshBlockhash } from "./ingestion/poller";
import { initGeyser, isGeyserAvailable, getLatestGeyserSlot }          from "./ingestion/geyser";
import { buildAndSubmitBundle, getRandomTipAccount }                    from "./execution/jito";
import { calculateDynamicTip }                                          from "./execution/tips";
import {
  createEntry,
  updateState,
  recordFailure,
  recordAiDecision,
  appendTipTrail,
  appendAgentDecision,
  incrementRetry,
  getEntry,
  getAllEntries,
  saveLog,
  getSummary,
  classifyFailure,
} from "./lifecycle/tracker";
import { reasonAboutFailure } from "./agent/reasoner";
import { generateAgentMemory } from "./reports/agentMemory";
import {
  TransactionState,
  TransactionFailure,
  UrgencyLevel,
  CongestionLevel,
} from "./types";

// ── Config ───────────────────────────────────────────────────
const RPC_URL         = process.env.HELIUS_RPC_URL ?? process.env.SOLANA_RPC_URL ?? "";
const MIN_BALANCE     = 0.1 * LAMPORTS_PER_SOL;
const TX_COUNT        = 10;
const FAULT_INJECT_AT = 5;

if (!RPC_URL) {
  console.error("[MAIN] HELIUS_RPC_URL is not set. Aborting.");
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function ensureFunds(connection: Connection, keypair: Keypair): Promise<void> {
  let balance = await connection.getBalance(keypair.publicKey);
  console.log(`[MAIN] Wallet: ${keypair.publicKey.toBase58()}`);
  console.log(`[MAIN] Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  if (balance < MIN_BALANCE) {
    console.log("[MAIN] Balance low — requesting devnet airdrop (2 SOL)...");
    try {
      const sig = await connection.requestAirdrop(keypair.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
      balance = await connection.getBalance(keypair.publicKey);
      console.log(`[MAIN] Airdrop confirmed. New balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[MAIN] Airdrop failed: ${msg}`);
    }
  }
}

function buildSelfTransfer(payer: Keypair): Transaction {
  return new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey:   payer.publicKey,
      lamports:   0,
    }),
  );
}

function urgencyForIndex(i: number): UrgencyLevel {
  if (i < 3) return "LOW";
  if (i < 6) return "MEDIUM";
  if (i < 8) return "HIGH";
  return "CRITICAL";
}

// Maps urgency to percentile label for tip_trail
function percentileForUrgency(urgency: UrgencyLevel): "p25" | "p50" | "p75" | "p95" {
  const map: Record<UrgencyLevel, "p25" | "p50" | "p75" | "p95"> = {
    LOW:      "p25",
    MEDIUM:   "p50",
    HIGH:     "p75",
    CRITICAL: "p95",
  };
  return map[urgency];
}

// ── Submit one transaction end-to-end ────────────────────────
async function runTransaction(
  connection: Connection,
  payer: Keypair,
  txIndex: number,
  useStaleBlockhash: boolean = false,
): Promise<void> {
  const label   = `TX #${txIndex + 1}${useStaleBlockhash ? " [FAULT: stale blockhash]" : ""}`;
  const urgency = urgencyForIndex(txIndex);

  console.log(`\n${"─".repeat(60)}`);
  console.log(`[MAIN] ${label} — urgency: ${urgency}`);

  // 1. Get dynamic tip
  const tipLamports = await calculateDynamicTip(urgency);

  // 2. Get tip account
  const tipAccount = await getRandomTipAccount();

  // 3. Build transaction
  const tx = buildSelfTransfer(payer);

  if (useStaleBlockhash) {
    console.log("[MAIN] FAULT: using pre-fetched stale blockhash (will expire)");
    tx.recentBlockhash = "11111111111111111111111111111111";
    tx.feePayer        = payer.publicKey;
    tx.sign(payer);
  }

  // 4. Submit via Jito
  let bundleResult;
  try {
    bundleResult = await buildAndSubmitBundle(connection, tx, payer, tipLamports, tipAccount);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[MAIN] Bundle submission threw: ${msg}`);
    return;
  }

  if (!bundleResult.success || !bundleResult.bundle_id) {
    console.error(`[MAIN] ${label} — bundle submission failed: ${bundleResult.error}`);
    return;
  }

  const signature = bundleResult.bundle_id;

  // 5. Create lifecycle entry
  createEntry(signature, bundleResult.submission_slot, tipLamports, bundleResult.bundle_id);

  // 6. Record first tip trail entry
  const networkCtxInitial = await getNetworkContext(connection);
  appendTipTrail(signature, tipLamports, networkCtxInitial.congestion_level, percentileForUrgency(urgency));

  // 7. Poll for lifecycle states
  let finalState = TransactionState.Submitted;

  try {
    const result = await pollTransactionStatus(
      connection,
      signature,
      (sig, state, slot, _ts) => { updateState(sig, state, slot); },
    );

    finalState = result.finalState;
    if (result.slot !== null) updateState(signature, finalState, result.slot);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[MAIN] Polling threw for ${label}: ${msg}`);
    finalState = TransactionState.Failed;
    const failure = classifyFailure(msg);
    recordFailure(signature, failure);
  }

  // 8. Handle failure with AI agent
  if (finalState === TransactionState.Failed) {
    const entry = getEntry(signature);
    if (!entry) return;

    if (!entry.failure_type) {
      const failType = useStaleBlockhash
        ? TransactionFailure.ExpiredBlockhash
        : TransactionFailure.Timeout;
      recordFailure(signature, failType);
    }

    const networkCtx = await getNetworkContext(connection);

    console.log(`\n[MAIN] Invoking Groq AI agent for ${label}...`);

    try {
      const updatedEntry = getEntry(signature)!;
      const decision     = await reasonAboutFailure(updatedEntry, networkCtx);

      // Persist full structured agent decision record
      appendAgentDecision(
        signature,
        updatedEntry.failure_type ?? TransactionFailure.Unknown,
        networkCtx,
        decision,
      );

      // Keep legacy string field too for backwards compat
      recordAiDecision(signature, JSON.stringify(decision, null, 2));

      if (decision.should_retry && decision.confidence_score >= 0.6) {
        console.log(`[MAIN] AI APPROVED retry for ${label} — new tip: ${decision.new_tip_lamports} lamports`);
        incrementRetry(signature);

        const retryTx      = buildSelfTransfer(payer);
        const retryTipAcct = await getRandomTipAccount();
        const retryNetCtx  = await getNetworkContext(connection);

        // Record retry tip in the trail
        appendTipTrail(
          signature,
          decision.new_tip_lamports,
          retryNetCtx.congestion_level,
          percentileForUrgency(urgency),
        );

        let retryBundle;
        try {
          retryBundle = await buildAndSubmitBundle(
            connection, retryTx, payer,
            decision.new_tip_lamports, retryTipAcct,
          );
        } catch (retryErr: unknown) {
          const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          console.error(`[MAIN] Retry bundle submission failed: ${msg}`);
          return;
        }

        if (retryBundle.success && retryBundle.bundle_id) {
          console.log(`[MAIN] Retry submitted — sig: ${retryBundle.bundle_id.slice(0, 12)}...`);

          createEntry(
            retryBundle.bundle_id,
            retryBundle.submission_slot,
            decision.new_tip_lamports,
            retryBundle.bundle_id,
          );

          await pollTransactionStatus(
            connection,
            retryBundle.bundle_id,
            (sig, state, slot, _ts) => { updateState(sig, state, slot); },
          );
        }
      } else {
        console.log(
          `[MAIN] AI REJECTED retry for ${label}` +
          ` — confidence: ${decision.confidence_score} should_retry: ${decision.should_retry}`,
        );
      }
    } catch (agentErr: unknown) {
      const msg = agentErr instanceof Error ? agentErr.message : String(agentErr);
      console.error(`[MAIN] AI agent error for ${label}: ${msg}`);
    }
  }

  console.log(`[MAIN] ${label} complete — final state: ${finalState}`);
}

// ── Main entry point ──────────────────────────────────────────
async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("=== SMART TX STACK — Made by TJS Code ===");
  console.log("=".repeat(60));

  const connection = new Connection(RPC_URL, "confirmed");

  let startSlot = 0;
  try {
    startSlot = await connection.getSlot("confirmed");
    console.log(`[MAIN] Connected to Solana devnet — current slot: ${startSlot}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[MAIN] Cannot connect to RPC: ${msg}`);
    process.exit(1);
  }

  await initGeyser();
  if (isGeyserAvailable()) {
    console.log(`[MAIN] Geyser stream active — latest slot: ${getLatestGeyserSlot()}`);
  } else {
    console.log("[MAIN] Geyser unavailable — using RPC polling fallback");
  }

  let payer: Keypair;
  if (process.env.WALLET_PRIVATE_KEY) {
    try {
      payer = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
      console.log("[MAIN] Loaded wallet from WALLET_PRIVATE_KEY");
    } catch (_) {
      console.warn("[MAIN] Could not parse WALLET_PRIVATE_KEY — generating fresh keypair");
      payer = Keypair.generate();
    }
  } else {
    payer = Keypair.generate();
    console.log("[MAIN] Generated fresh devnet keypair");
  }

  await ensureFunds(connection, payer);

  console.log("\n[MAIN] Pre-fetching blockhash for fault injection (will go stale)...");
  let staleBlockhash: string;
  try {
    const bh       = await getFreshBlockhash(connection);
    staleBlockhash = bh.blockhash;
    console.log(`[MAIN] Stale blockhash pre-fetched: ${staleBlockhash.slice(0, 12)}...`);
  } catch (_) {
    staleBlockhash = "11111111111111111111111111111111";
    console.warn("[MAIN] Could not pre-fetch stale blockhash — using known-invalid placeholder");
  }

  for (let i = 0; i < TX_COUNT; i++) {
    const isFaultTx = i === FAULT_INJECT_AT;

    if (isFaultTx) {
      console.log(
        `\n[MAIN] ⚠  FAULT INJECTION — waiting 90s for blockhash to expire`,
      );
      await sleep(90_000);
    }

    try {
      await runTransaction(connection, payer, i, isFaultTx);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[MAIN] TX #${i + 1} threw unexpectedly: ${msg}`);
    }

    if (i < TX_COUNT - 1) await sleep(2_000);
  }

  // Save lifecycle log
  console.log("\n" + "=".repeat(60));
  console.log("[MAIN] Saving lifecycle proof log...");
  saveLog();

  // Generate AGENT_MEMORY.md
  console.log("[MAIN] Generating agent memory report...");
  const allEntries = getAllEntries();
  const summary    = getSummary();
  generateAgentMemory(allEntries, summary, startSlot);

  // Print summary
  console.log("\n" + "=".repeat(60));
  console.log("=== FINAL SUMMARY — Made by TJS Code ===");
  console.log("=".repeat(60));
  console.log(`Total Transactions:       ${summary.total_transactions}`);
  console.log(`Successful (Finalized):   ${summary.successful}`);
  console.log(`Failed:                   ${summary.failed}`);
  console.log(`Success Rate:             ${summary.success_rate_pct.toFixed(1)}%`);
  console.log(`Avg Confirmation Time:    ${summary.avg_confirmation_ms}ms`);
  console.log(`Total Tips Paid:          ${summary.total_tips_paid_lamports} lamports`);
  console.log(`AI Interventions:         ${summary.ai_interventions}`);
  console.log(`AI Approved Retries:      ${summary.ai_approved_retries}`);
  console.log(`AI Rejected Retries:      ${summary.ai_rejected_retries}`);
  console.log("=".repeat(60));
  console.log("[MAIN] Done. Verify signatures at https://explorer.solana.com/?cluster=devnet");
  console.log("[MAIN] Made by TJS Code — https://github.com/OlatundeOlabanj/smart-tx-stack");
}

main().catch((err) => {
  console.error("[MAIN] Fatal error:", err);
  process.exit(1);
});
