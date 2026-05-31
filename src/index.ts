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
  PublicKey,
} from "@solana/web3.js";
import bs58 from "bs58";

import { pollTransactionStatus, getNetworkContext, getFreshBlockhash } from "./ingestion/poller";
import { initGeyser, isGeyserAvailable, getLatestGeyserSlot } from "./ingestion/geyser";
import { buildAndSubmitBundle, getRandomTipAccount }                   from "./execution/jito";
import { calculateDynamicTip }                                         from "./execution/tips";
import {
  createEntry,
  updateState,
  recordFailure,
  recordAiDecision,
  incrementRetry,
  getEntry,
  saveLog,
  getSummary,
  classifyFailure,
} from "./lifecycle/tracker";
import { reasonAboutFailure }                                          from "./agent/reasoner";
import {
  TransactionState,
  TransactionFailure,
  UrgencyLevel,
} from "./types";

// ── Config ───────────────────────────────────────────────────
const RPC_URL        = process.env.HELIUS_RPC_URL ?? process.env.SOLANA_RPC_URL ?? "";
const MIN_BALANCE    = 0.1 * LAMPORTS_PER_SOL;
const TX_COUNT       = 10;
const FAULT_INJECT_AT = 5; // inject stale blockhash after tx index 4 (0-based)

if (!RPC_URL) {
  console.error("[MAIN] HELIUS_RPC_URL is not set. Aborting.");
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────
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
      console.warn(`[MAIN] Airdrop failed: ${msg} — continuing with existing balance`);
    }
  }
}

// ── Build a 0-SOL self-transfer transaction ───────────────────
function buildSelfTransfer(payer: Keypair): Transaction {
  return new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey:   payer.publicKey,
      lamports:   0,
    }),
  );
}

// ── Urgency mapping by tx index ───────────────────────────────
function urgencyForIndex(i: number): UrgencyLevel {
  if (i < 3)  return "LOW";
  if (i < 6)  return "MEDIUM";
  if (i < 8)  return "HIGH";
  return "CRITICAL";
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

  // ── 1. Get dynamic tip ────────────────────────────────────
  const tipLamports = await calculateDynamicTip(urgency);

  // ── 2. Get tip account ────────────────────────────────────
  const tipAccount = await getRandomTipAccount();

  // ── 3. Build transaction ──────────────────────────────────
  const tx = buildSelfTransfer(payer);

  // If fault injection: set an already-expired blockhash
  if (useStaleBlockhash) {
    console.log("[MAIN] FAULT: using pre-fetched stale blockhash (will expire)");
    tx.recentBlockhash = "11111111111111111111111111111111"; // deliberately invalid
    tx.feePayer        = payer.publicKey;
    tx.sign(payer);
  }

  // ── 4. Submit via Jito ────────────────────────────────────
  let bundleResult;
  try {
    bundleResult = await buildAndSubmitBundle(
      connection,
      tx,
      payer,
      tipLamports,
      tipAccount,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[MAIN] Bundle submission threw: ${msg}`);
    return;
  }

  if (!bundleResult.success || !bundleResult.bundle_id) {
    // Detect JitoLeaderSkipped at submission time
    if (bundleResult.error === TransactionFailure.JitoLeaderSkipped) {
      console.error(`[MAIN] ${label} — JitoLeaderSkipped at submission`);
    } else {
      console.error(`[MAIN] ${label} — bundle submission failed: ${bundleResult.error}`);
    }
    return;
  }

  // The bundle_id doubles as the signature in fallback mode
  const signature = bundleResult.bundle_id;

  // ── 5. Create lifecycle entry ─────────────────────────────
  createEntry(signature, bundleResult.submission_slot, tipLamports, bundleResult.bundle_id);

  // ── 6. Poll for lifecycle states ─────────────────────────
  let finalState = TransactionState.Submitted;

  try {
    const result = await pollTransactionStatus(
      connection,
      signature,
      (sig, state, slot, _ts) => {
        updateState(sig, state, slot);
      },
    );

    finalState = result.finalState;

    if (result.slot !== null) {
      updateState(signature, finalState, result.slot);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[MAIN] Polling threw for ${label}: ${msg}`);
    finalState = TransactionState.Failed;
    const failure = classifyFailure(msg);
    recordFailure(signature, failure);
  }

  // ── 7. Handle failure with AI agent ──────────────────────
  if (finalState === TransactionState.Failed) {
    const entry = getEntry(signature);
    if (!entry) return;

    // Determine failure type if not already set
    if (!entry.failure_type) {
      const failType = useStaleBlockhash
        ? TransactionFailure.ExpiredBlockhash
        : TransactionFailure.Timeout;
      recordFailure(signature, failType);
    }

    // Get current network context for AI
    const networkCtx = await getNetworkContext(connection);

    console.log(`\n[MAIN] Invoking Groq AI agent for ${label}...`);

    try {
      const updatedEntry = getEntry(signature)!;
      const decision     = await reasonAboutFailure(updatedEntry, networkCtx);

      // Persist full AI reasoning as JSON string
      const decisionJson = JSON.stringify(decision, null, 2);
      recordAiDecision(signature, decisionJson);

      if (decision.should_retry && decision.confidence_score >= 0.6) {
        console.log(
          `[MAIN] AI APPROVED retry for ${label} — new tip: ${decision.new_tip_lamports} lamports`,
        );
        incrementRetry(signature);

        // One retry attempt with AI-recommended tip
        const retryTx      = buildSelfTransfer(payer);
        const retryTipAcct = await getRandomTipAccount();

        let retryBundle;
        try {
          retryBundle = await buildAndSubmitBundle(
            connection,
            retryTx,
            payer,
            decision.new_tip_lamports,
            retryTipAcct,
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

          // Poll the retry
          await pollTransactionStatus(
            connection,
            retryBundle.bundle_id,
            (sig, state, slot, _ts) => {
              updateState(sig, state, slot);
            },
          );
        }
      } else {
        console.log(
          `[MAIN] AI REJECTED retry for ${label}` +
          ` — confidence: ${decision.confidence_score}` +
          ` should_retry: ${decision.should_retry}`,
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

  // ── Startup slot confirmation ─────────────────────────────
  let startSlot = 0;
  try {
    startSlot = await connection.getSlot("confirmed");
    console.log(`[MAIN] Connected to Solana devnet — current slot: ${startSlot}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[MAIN] Cannot connect to RPC: ${msg}`);
    process.exit(1);
  }

  // ── Initialise Geyser stream ─────────────────────────────
  await initGeyser();
  if (isGeyserAvailable()) {
    console.log(`[MAIN] Geyser stream active — latest slot: ${getLatestGeyserSlot()}`);
  } else {
    console.log("[MAIN] Geyser unavailable — using RPC polling fallback");
  }

  // ── Load or generate wallet ───────────────────────────────
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

  // ── Ensure funded ─────────────────────────────────────────
  await ensureFunds(connection, payer);

  // ── Pre-fetch stale blockhash for fault injection ─────────
  // Fetch NOW, then use it AFTER tx 5 — it will have expired by then
  console.log("\n[MAIN] Pre-fetching blockhash for fault injection (will go stale)...");
  let staleBlockhash: string;
  try {
    const bh     = await getFreshBlockhash(connection);
    staleBlockhash = bh.blockhash;
    console.log(`[MAIN] Stale blockhash pre-fetched: ${staleBlockhash.slice(0, 12)}...`);
  } catch (err: unknown) {
    staleBlockhash = "11111111111111111111111111111111";
    console.warn("[MAIN] Could not pre-fetch stale blockhash — using known-invalid placeholder");
  }

  // ── Run 10 transactions ───────────────────────────────────
  let aiInterventionCount = 0;

  for (let i = 0; i < TX_COUNT; i++) {
    const isFaultTx = i === FAULT_INJECT_AT;

    if (isFaultTx) {
      // After tx 5: wait 90s so the pre-fetched blockhash expires
      console.log(
        `\n[MAIN] ⚠  FAULT INJECTION — waiting 90s for blockhash ${staleBlockhash.slice(0, 12)}... to expire`,
      );
      await sleep(90_000);
    }

    try {
      await runTransaction(connection, payer, i, isFaultTx);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[MAIN] TX #${i + 1} threw unexpectedly: ${msg}`);
    }

    // Brief pause between transactions to avoid rate limiting
    if (i < TX_COUNT - 1) await sleep(2_000);
  }

  // ── Save logs ─────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log("[MAIN] Saving lifecycle proof log...");
  saveLog();

  // ── Print summary ─────────────────────────────────────────
  const summary = getSummary();
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
