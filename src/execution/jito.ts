// ============================================================
// smart-tx-stack — src/execution/jito.ts
// Jito bundle builder + submitter for Solana devnet
// Uses /api/v1/transactions sendTransaction endpoint —
// packs user instruction + tip transfer in a single tx.
// Jito wraps it as a bundle internally, returns bundle ID
// in x-bundle-id response header.
// Made by TJS Code
// ============================================================

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { BundleSubmissionResult, TransactionFailure } from "../types";

// ── Jito testnet block engine ─────────────────────────────────
const JITO_BLOCK_ENGINE_URL = "https://dallas.testnet.block-engine.jito.wtf";
const JITO_TX_URL           = `${JITO_BLOCK_ENGINE_URL}/api/v1/transactions`;

// Known Jito tip accounts (mainnet — also used on testnet block engine)
const KNOWN_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

export interface JitoSubmissionError {
  code:            number;
  message:         string;
  isLeaderSkipped: boolean;
}

// ── Fetch live tip accounts ───────────────────────────────────
export async function getTipAccounts(): Promise<string[]> {
  try {
    const res = await fetch(`${JITO_BLOCK_ENGINE_URL}/api/v1/bundles/tip_accounts`, {
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) throw new Error(`Jito tip accounts API returned ${res.status}`);
    const data: any = await res.json();
    const accounts: string[] = Array.isArray(data) ? data : (data.accounts ?? []);
    if (accounts.length === 0) throw new Error("Empty tip accounts list");
    console.log(`[JITO] Fetched ${accounts.length} live tip accounts`);
    return accounts;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[JITO] Could not fetch live tip accounts (${msg}), using known accounts`);
    return KNOWN_TIP_ACCOUNTS;
  }
}

export async function getRandomTipAccount(): Promise<PublicKey> {
  const accounts = await getTipAccounts();
  const chosen   = accounts[Math.floor(Math.random() * accounts.length)];
  return new PublicKey(chosen);
}

// ── Build and submit via Jito sendTransaction ─────────────────
// Packs user instruction + tip transfer into ONE transaction.
// Submits to /api/v1/transactions — Jito wraps it as a bundle
// internally. Bundle ID returned in x-bundle-id response header.
// Uses base64 encoding (sendTransaction requirement).
export async function buildAndSubmitBundle(
  connection:  Connection,
  transaction: Transaction,
  payer:       Keypair,
  tipLamports: number,
  tipAccount:  PublicKey,
): Promise<BundleSubmissionResult> {
  let submissionSlot = 0;
  try {
    submissionSlot = await connection.getSlot("confirmed");
  } catch (_) { /* non-fatal */ }

  // ── Fetch fresh blockhash ─────────────────────────────────
  let blockhash: string;
  try {
    const bh  = await connection.getLatestBlockhash("confirmed");
    blockhash = bh.blockhash;
  } catch (err: unknown) {
    throw new Error(`Failed to fetch blockhash for bundle: ${(err as Error).message}`);
  }

  // ── Extract user instructions ─────────────────────────────
  // Pull instructions from the incoming transaction so we can
  // pack them alongside the tip transfer in a single tx
  const userInstructions: TransactionInstruction[] = transaction.instructions.length > 0
    ? transaction.instructions
    : [];

  // ── Build tip instruction ─────────────────────────────────
  const tipInstruction = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey:   tipAccount,
    lamports:   tipLamports,
  });

  // ── Build combined transaction: [userIx..., tipIx] ────────
  // Single transaction with both payload and tip packed together
  const combinedTx = new Transaction();
  for (const ix of userInstructions) {
    combinedTx.add(ix);
  }
  combinedTx.add(tipInstruction);

  combinedTx.recentBlockhash = blockhash;
  combinedTx.feePayer        = payer.publicKey;
  combinedTx.sign(payer);

  // ── Pre-submission simulation ─────────────────────────────
  // Validates compute budget and instruction logic before Jito
  try {
    console.log("[JITO] Simulating transaction before submission...");
    const sim = await connection.simulateTransaction(combinedTx, [payer]);
    if (sim.value.err) {
      console.warn(`[JITO] Simulation warning: ${JSON.stringify(sim.value.err)}`);
    } else {
      console.log(`[JITO] Simulation passed — units: ${sim.value.unitsConsumed ?? "N/A"}`);
    }
  } catch (_) { /* non-fatal */ }

  // ── Serialize as base64 (sendTransaction requirement) ─────
  const serialized = combinedTx.serialize().toString("base64");

  console.log(
    `[JITO] Submitting via sendTransaction — tip: ${tipLamports} lamports` +
    ` → ${tipAccount.toBase58().slice(0, 12)}... slot: ${submissionSlot}`,
  );

  // ── POST to /api/v1/transactions ──────────────────────────
  let response: Response;
  try {
    response = await fetch(JITO_TX_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id:      1,
        method:  "sendTransaction",
        params:  [serialized, { encoding: "base64" }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[JITO] Jito unreachable: ${msg} — falling back to standard RPC`);
    return fallbackSubmit(connection, combinedTx, payer, submissionSlot);
  }

  // ── Extract bundle ID from response header ────────────────
  const bundleId = response.headers.get("x-bundle-id") ?? "";

  const responseData: any = await response.json().catch(() => ({}));

  if (responseData.error) {
    const jitoErr = parseJitoError(responseData.error);
    if (jitoErr.isLeaderSkipped) {
      console.error("[JITO] Leader skipped slot — surfacing as JitoLeaderSkipped");
      return {
        bundle_id:       "",
        submission_slot: submissionSlot,
        success:         false,
        error:           TransactionFailure.JitoLeaderSkipped,
        used_fallback:   false,
      };
    }
    console.warn(`[JITO] Jito error (${jitoErr.message}) — falling back`);
    return fallbackSubmit(connection, combinedTx, payer, submissionSlot);
  }

  // ── Success path ──────────────────────────────────────────
  // responseData.result is the transaction signature
  const signature = responseData.result ?? bundleId;

  if (!signature) {
    console.warn("[JITO] No signature in response — falling back");
    return fallbackSubmit(connection, combinedTx, payer, submissionSlot);
  }

  if (bundleId) {
    console.log(`[JITO] Bundle accepted — bundleId: ${bundleId.slice(0, 12)}... sig: ${signature.slice(0, 12)}...`);
  } else {
    console.log(`[JITO] Transaction accepted — sig: ${signature.slice(0, 12)}... slot: ${submissionSlot}`);
  }

  return {
    bundle_id:       signature,   // use sig as the tracking ID for lifecycle
    submission_slot: submissionSlot,
    success:         true,
    used_fallback:   false,
  };
}

// ── Fallback: standard sendRawTransaction ────────────────────
async function fallbackSubmit(
  connection:     Connection,
  transaction:    Transaction,
  payer:          Keypair,
  submissionSlot: number,
): Promise<BundleSubmissionResult> {
  console.warn("[JITO] FALLBACK — submitting via standard sendRawTransaction");
  try {
    const bh                    = await connection.getLatestBlockhash("confirmed");
    transaction.recentBlockhash = bh.blockhash;
    transaction.feePayer        = payer.publicKey;
    transaction.sign(payer);

    const signature = await connection.sendRawTransaction(
      transaction.serialize(),
      { skipPreflight: false, preflightCommitment: "confirmed" },
    );
    console.log(`[JITO] Fallback sent — sig: ${signature.slice(0, 12)}...`);
    return {
      bundle_id:       signature,
      submission_slot: submissionSlot,
      success:         true,
      used_fallback:   true,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[JITO] Fallback also failed: ${msg}`);
    return {
      bundle_id:       "",
      submission_slot: submissionSlot,
      success:         false,
      error:           msg,
      used_fallback:   true,
    };
  }
}

// ── Parse Jito error objects ──────────────────────────────────
function parseJitoError(error: { code?: number; message?: string }): JitoSubmissionError {
  const message         = error.message ?? "Unknown Jito error";
  const code            = error.code    ?? -1;
  const isLeaderSkipped =
    message.toLowerCase().includes("leader") &&
    message.toLowerCase().includes("skip");
  return { code, message, isLeaderSkipped };
}
