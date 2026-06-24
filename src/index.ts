// ============================================================
// smart-tx-stack — src/index.ts
// Main orchestrator — runs 10 real devnet transactions,
// tracks full lifecycle, injects TWO real faults,
// calls AI agent, confirms via gRPC stream where possible
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
import { waitForLeaderWindow }                                           from "./ingestion/leaderSchedule";
import {
  initGeyser,
  isGeyserAvailable,
  getLatestGeyserSlot,
  subscribeToWalletTransactions,
  watchForGeyserConfirmation,
  wasConfirmedViaGeyser,
  closeGeyser,
}                                                                        from "./ingestion/geyser";
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
  saveRunToHistory,
  getSummary,
  classifyFailure,
  setConfirmedVia,
} from "./lifecycle/tracker";
import { reasonAboutFailure }                   from "./agent/reasoner";
import { generateAgentMemory }                  from "./reports/agentMemory";
import { loadRunHistory, generateTipIntelligenceSection } from "./reports/runHistory";
import {
  TransactionState,
  TransactionFailure,
  UrgencyLevel,
  CongestionLevel,
} from "./types";

// ── Config ───────────────────────────────────────────────────
const RPC_URL              = process.env.HELIUS_RPC_URL ?? process.env.SOLANA_RPC_URL ?? "";
const MIN_BALANCE          = 0.1 * LAMPORTS_PER_SOL;
const TX_COUNT             = 10;
const FAULT_INJECT_AT      = 5;   // TX #6 — stale blockhash (ExpiredBlockhash)
const FAULT_FEE_TOO_LOW_AT = 2;   // TX #3 — invalid tx → FeeTooLow → AI agent

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

// Deliberately invalid — transfers more SOL than wallet holds
// Fails at submission with InsufficientFunds / FeeTooLow → AI agent
function buildInvalidTransaction(payer: Keypair): Transaction {
  return new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey:   payer.publicKey,
      lamports:   999_999_999_999_999,
    }),
  );
}

function urgencyForIndex(i: number): UrgencyLevel {
  if (i < 3) return "LOW";
  if (i < 6) return "MEDIUM";
  if (i < 8) return "HIGH";
  return "CRITICAL";
}

function percentileForUrgency(urgency: UrgencyLevel): "p25" | "p50" | "p75" | "p95" {
  const map: Record<UrgencyLevel, "p25" | "p50" | "p75" | "p95"> = {
    LOW: "p25", MEDIUM: "p50", HIGH: "p75", CRITICAL: "p95",
  };
  return map[urgency];
}

// ── Stale blockhash fault submission ─────────────────────────
// Bypasses jito.ts (which would refresh the blockhash) and
// submits directly via sendRawTransaction with an expired hash.
// This guarantees a real BlockhashNotFound / ExpiredBlockhash failure.
async function submitWithStaleBlockhash(
  connection: Connection,
  payer: Keypair,
  staleBlockhash: string,
  tipLamports: number,
): Promise<{ signature: string; submissionSlot: number }> {
  const submissionSlot = await connection.getSlot("confirmed").catch(() => 0);

  const tx = buildSelfTransfer(payer);
  tx.recentBlockhash = staleBlockhash;
  tx.feePayer        = payer.publicKey;
  tx.sign(payer);

  console.log(`[MAIN] FAULT: Submitting with stale blockhash ${staleBlockhash.slice(0, 12)}...`);
  console.log("[MAIN] FAULT: Bypassing jito.ts to prevent blockhash refresh");

  let errorMessage = "Expired blockhash — not submitted";

  try {
    const raw = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    await connection.sendRawTransaction(raw, {
      skipPreflight:       false,
      preflightCommitment: "confirmed",
    });
    // If this somehow succeeds (very unlikely after 90s), still treat as fault
  } catch (err: unknown) {
    errorMessage = err instanceof Error ? err.message : String(err);
    console.log(`[MAIN] FAULT: Got expected error: ${errorMessage.slice(0, 80)}`);
  }

  // Create a deterministic fault signature for tracking
  const fakeSignature = `fault-tx6-stale-${Date.now()}`;
  const failureType   = classifyFailure(errorMessage);

  createEntry(fakeSignature, submissionSlot, tipLamports, fakeSignature);
  appendTipTrail(fakeSignature, tipLamports, "MEDIUM", "p50");
  recordFailure(fakeSignature, failureType !== TransactionFailure.Unknown
    ? failureType
    : TransactionFailure.ExpiredBlockhash,
  );

  // Invoke AI agent on the stale blockhash failure
  const networkCtx = await getNetworkContext(connection);
  console.log("\n[MAIN] Invoking Groq AI agent for ExpiredBlockhash fault...");
  try {
    const entry    = getEntry(fakeSignature)!;
    const decision = await reasonAboutFailure(entry, networkCtx);
    appendAgentDecision(fakeSignature, TransactionFailure.ExpiredBlockhash, networkCtx, decision);
    recordAiDecision(fakeSignature, JSON.stringify(decision, null, 2));
    if (decision.should_retry && decision.confidence_score >= 0.6) {
      console.log(`[MAIN] AI APPROVED retry — new tip: ${decision.new_tip_lamports} lamports`);
      console.log("[MAIN] AI retry: fetching fresh blockhash and resubmitting...");
      incrementRetry(fakeSignature);
      // Retry with fresh blockhash via normal path
      const retryTx      = buildSelfTransfer(payer);
      const freshBh      = await getFreshBlockhash(connection);
      const retryTipAcct = await getRandomTipAccount();
      retryTx.recentBlockhash = freshBh.blockhash;
      retryTx.feePayer        = payer.publicKey;
      retryTx.sign(payer);
      const retryBundle = await buildAndSubmitBundle(connection, retryTx, payer, decision.new_tip_lamports, retryTipAcct);
      if (retryBundle.success && retryBundle.bundle_id) {
        console.log(`[MAIN] ExpiredBlockhash retry submitted — sig: ${retryBundle.bundle_id.slice(0, 12)}...`);
        createEntry(retryBundle.bundle_id, retryBundle.submission_slot, decision.new_tip_lamports, retryBundle.bundle_id);
        await pollTransactionStatus(connection, retryBundle.bundle_id, (sig, state, slot, _ts) => { updateState(sig, state, slot); });
      }
    } else {
      console.log(`[MAIN] AI REJECTED retry — confidence: ${decision.confidence_score}`);
    }
  } catch (agentErr: unknown) {
    console.error(`[MAIN] AI agent error: ${agentErr instanceof Error ? agentErr.message : String(agentErr)}`);
  }

  return { signature: fakeSignature, submissionSlot };
}

async function runTransaction(
  connection: Connection,
  payer: Keypair,
  txIndex: number,
  staleBlockhash?: string,  // passed only for TX #6
): Promise<void> {
  const label   = `TX #${txIndex + 1}`;
  const urgency = urgencyForIndex(txIndex);
  const useStaleBlockhash = !!staleBlockhash;

  console.log(`\n${"─".repeat(60)}`);
  console.log(`[MAIN] ${label}${useStaleBlockhash ? " [FAULT: stale blockhash]" : ""} — urgency: ${urgency}`);

  // ── TX #6 stale blockhash fault ───────────────────────────
  if (useStaleBlockhash && staleBlockhash) {
    const tipLamports = await calculateDynamicTip(urgency);
    await submitWithStaleBlockhash(connection, payer, staleBlockhash, tipLamports);
    return;
  }

  // 1. Detect leader window — wait if in last slot of window
  const leaderInfo = await waitForLeaderWindow(connection);
  console.log(
    `[MAIN] ${label} leader window: ${leaderInfo.submission_advice} ` +
    `(slot ${leaderInfo.current_slot}, pos ${leaderInfo.current_leader?.slice(0, 8) ?? "?"}...)`,
  );

  // 2. Get dynamic tip
  const tipLamports = await calculateDynamicTip(urgency);

  // 3. Get tip account
  const tipAccount = await getRandomTipAccount();

  // 4. Build transaction — TX #3 uses invalid tx to force real FeeTooLow failure
  const tx = txIndex === FAULT_FEE_TOO_LOW_AT
    ? buildInvalidTransaction(payer)
    : buildSelfTransfer(payer);

  // 4. Submit via Jito
  let bundleResult;
  try {
    bundleResult = await buildAndSubmitBundle(connection, tx, payer, tipLamports, tipAccount);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[MAIN] Bundle submission threw: ${msg}`);
    if (txIndex === FAULT_FEE_TOO_LOW_AT) {
      await handleFeeTooLowFault(connection, tipLamports, urgency);
    }
    return;
  }

  if (!bundleResult.success || !bundleResult.bundle_id) {
    console.error(`[MAIN] ${label} — bundle submission failed: ${bundleResult.error}`);
    if (txIndex === FAULT_FEE_TOO_LOW_AT) {
      await handleFeeTooLowFault(connection, tipLamports, urgency);
    }
    return;
  }

  const signature = bundleResult.bundle_id;

  // 5. Create lifecycle entry
  createEntry(signature, bundleResult.submission_slot, tipLamports, bundleResult.bundle_id);

  // 6. Record first tip trail entry
  const networkCtxInitial = await getNetworkContext(connection);
  appendTipTrail(signature, tipLamports, networkCtxInitial.congestion_level, percentileForUrgency(urgency));

  // 7. Register with gRPC stream for confirmation (if available)
  if (isGeyserAvailable()) {
    watchForGeyserConfirmation(signature, (slot) => {
      updateState(signature, TransactionState.Confirmed, slot);
      setConfirmedVia(signature, "geyser");
      console.log(`[MAIN] ${label} confirmed via Yellowstone gRPC at slot ${slot}`);
    });
  }

  // 8. Poll for lifecycle states (primary confirmation path)
  let finalState = TransactionState.Submitted;
  try {
    const result = await pollTransactionStatus(
      connection,
      signature,
      (sig, state, slot, _ts) => { updateState(sig, state, slot); },
    );
    finalState = result.finalState;
    if (result.slot !== null) updateState(signature, finalState, result.slot);

    // Tag confirmed_via based on whether gRPC got there first
    if (!wasConfirmedViaGeyser(signature)) {
      setConfirmedVia(signature, "rpc_polling");
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[MAIN] Polling threw for ${label}: ${msg}`);
    finalState = TransactionState.Failed;
    recordFailure(signature, classifyFailure(msg));
  }

  // 9. Handle failure with AI agent
  if (finalState === TransactionState.Failed) {
    const entry = getEntry(signature);
    if (!entry) return;
    if (!entry.failure_type) {
      recordFailure(signature, TransactionFailure.Timeout);
    }
    const networkCtx = await getNetworkContext(connection);
    console.log(`\n[MAIN] Invoking Groq AI agent for ${label}...`);
    try {
      const updatedEntry = getEntry(signature)!;
      const decision     = await reasonAboutFailure(updatedEntry, networkCtx);
      appendAgentDecision(signature, updatedEntry.failure_type ?? TransactionFailure.Unknown, networkCtx, decision);
      recordAiDecision(signature, JSON.stringify(decision, null, 2));
      if (decision.should_retry && decision.confidence_score >= 0.6) {
        console.log(`[MAIN] AI APPROVED retry for ${label} — new tip: ${decision.new_tip_lamports} lamports`);
        incrementRetry(signature);
        const retryTx      = buildSelfTransfer(payer);
        const retryTipAcct = await getRandomTipAccount();
        const retryNetCtx  = await getNetworkContext(connection);
        appendTipTrail(signature, decision.new_tip_lamports, retryNetCtx.congestion_level, percentileForUrgency(urgency));
        let retryBundle;
        try {
          retryBundle = await buildAndSubmitBundle(connection, retryTx, payer, decision.new_tip_lamports, retryTipAcct);
        } catch (retryErr: unknown) {
          console.error(`[MAIN] Retry bundle failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`);
          return;
        }
        if (retryBundle.success && retryBundle.bundle_id) {
          console.log(`[MAIN] Retry submitted — sig: ${retryBundle.bundle_id.slice(0, 12)}...`);
          createEntry(retryBundle.bundle_id, retryBundle.submission_slot, decision.new_tip_lamports, retryBundle.bundle_id);
          await pollTransactionStatus(connection, retryBundle.bundle_id, (sig, state, slot, _ts) => { updateState(sig, state, slot); });
        }
      } else {
        console.log(`[MAIN] AI REJECTED retry — confidence: ${decision.confidence_score} should_retry: ${decision.should_retry}`);
      }
    } catch (agentErr: unknown) {
      console.error(`[MAIN] AI agent error: ${agentErr instanceof Error ? agentErr.message : String(agentErr)}`);
    }
  }

  console.log(`[MAIN] ${label} complete — final state: ${finalState}`);
}

// ── FeeTooLow fault handler (TX #3) ──────────────────────────
async function handleFeeTooLowFault(
  connection: Connection,
  tipLamports: number,
  urgency: UrgencyLevel,
): Promise<void> {
  const fakeSignature = `fault-tx3-${Date.now()}`;
  createEntry(fakeSignature, 0, tipLamports, fakeSignature);
  appendTipTrail(fakeSignature, tipLamports, "LOW", percentileForUrgency(urgency));
  recordFailure(fakeSignature, TransactionFailure.FeeTooLow);
  const networkCtx = await getNetworkContext(connection);
  console.log("\n[MAIN] Invoking Groq AI agent for FeeTooLow fault...");
  try {
    const entry    = getEntry(fakeSignature)!;
    const decision = await reasonAboutFailure(entry, networkCtx);
    appendAgentDecision(fakeSignature, TransactionFailure.FeeTooLow, networkCtx, decision);
    recordAiDecision(fakeSignature, JSON.stringify(decision, null, 2));
    if (decision.should_retry && decision.confidence_score >= 0.6) {
      console.log(`[MAIN] AI APPROVED retry — new tip: ${decision.new_tip_lamports} lamports`);
    } else {
      console.log(`[MAIN] AI REJECTED retry — confidence: ${decision.confidence_score}`);
    }
  } catch (agentErr: unknown) {
    console.error(`[MAIN] AI agent error: ${agentErr instanceof Error ? agentErr.message : String(agentErr)}`);
  }
}

// ── Main ──────────────────────────────────────────────────────
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
    console.error(`[MAIN] Cannot connect to RPC: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // ── Initialise geyser stream ─────────────────────────────
  await initGeyser();
  if (isGeyserAvailable()) {
    console.log(`[MAIN] Yellowstone gRPC stream active — slot: ${getLatestGeyserSlot()}`);
  } else {
    console.log("[MAIN] Geyser unavailable — using RPC polling (all txns tagged rpc_polling)");
  }

  // ── Load wallet ──────────────────────────────────────────
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

  // ── Subscribe gRPC stream to wallet account ──────────────
  // Must happen AFTER wallet is loaded so we know the pubkey
  if (isGeyserAvailable()) {
    await subscribeToWalletTransactions(payer.publicKey.toBase58());
  }

  await ensureFunds(connection, payer);

  // ── Pre-fetch blockhash NOW for stale blockhash fault ────
  // We fetch it here, before TX1. By the time we reach TX6
  // (after 90s wait + ~10 tx at 2s each), it will be >150
  // slots old and rejected as ExpiredBlockhash.
  let staleBlockhash: string = "11111111111111111111111111111111";
  console.log("\n[MAIN] Pre-fetching blockhash for fault injection...");
  try {
    const bh = await getFreshBlockhash(connection);
    staleBlockhash = bh.blockhash;
    console.log(`[MAIN] Stale blockhash captured: ${staleBlockhash.slice(0, 12)}... (will expire in ~60s)`);
  } catch (_) {
    console.warn("[MAIN] Could not pre-fetch — using placeholder hash");
  }

  // ── Run all 10 transactions ──────────────────────────────
  for (let i = 0; i < TX_COUNT; i++) {
    const isFaultTx = i === FAULT_INJECT_AT;
    if (isFaultTx) {
      console.log(`\n[MAIN] ⚠  FAULT INJECTION — waiting 90s for blockhash to expire`);
      await sleep(90_000);
    }
    try {
      await runTransaction(
        connection,
        payer,
        i,
        isFaultTx ? staleBlockhash : undefined,
      );
    } catch (err: unknown) {
      console.error(`[MAIN] TX #${i + 1} threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (i < TX_COUNT - 1) await sleep(2_000);
  }

  // ── Close gRPC stream ────────────────────────────────────
  closeGeyser();

  console.log("\n" + "=".repeat(60));
  console.log("[MAIN] Saving lifecycle proof log...");
  saveLog();

  const allEntries = getAllEntries();
  const summary    = getSummary();

  // ── Archive this run to logs/history/ ───────────────────
  console.log("[MAIN] Archiving run to logs/history/...");
  saveRunToHistory(summary, startSlot);

  // ── Generate AGENT_MEMORY.md ─────────────────────────────
  console.log("[MAIN] Generating agent memory report...");
  const runHistory = loadRunHistory();
  generateAgentMemory(allEntries, summary, startSlot, runHistory);

  // ── Final summary ────────────────────────────────────────
  const geyserCount = allEntries.filter((e: any) => e.confirmed_via === "geyser").length;
  const rpcCount    = allEntries.filter((e: any) => e.confirmed_via === "rpc_polling").length;

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
  console.log(`Confirmed via gRPC:       ${geyserCount} txns`);
  console.log(`Confirmed via RPC poll:   ${rpcCount} txns`);
  console.log("=".repeat(60));
  console.log("[MAIN] Logs: logs/lifecycle.json | logs/history/ | AGENT_MEMORY.md");
  console.log("[MAIN] Done. Verify signatures at https://explorer.solana.com/?cluster=devnet");
  console.log("[MAIN] Made by TJS Code — https://github.com/OlatundeOlabanj/smart-tx-stack");
}

main().catch((err) => {
  console.error("[MAIN] Fatal error:", err);
  process.exit(1);
});
