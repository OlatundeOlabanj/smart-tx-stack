// ============================================================
// smart-tx-stack — src/execution/jito.ts
// Jito bundle builder + submitter for Solana devnet
// Made by TJS Code
// ============================================================

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { BundleSubmissionResult, TransactionFailure } from "../types";

// ── Jito devnet block engine endpoint ────────────────────────
const JITO_BLOCK_ENGINE_URL = "https://dallas.testnet.block-engine.jito.wtf";
const JITO_TIP_ACCOUNTS_URL = `${JITO_BLOCK_ENGINE_URL}/api/v1/bundles`;
const JITO_BUNDLES_URL      = `${JITO_BLOCK_ENGINE_URL}/api/v1/bundles`;

// Known devnet tip accounts (Jito publishes these; we also fetch live)
const KNOWN_DEVNET_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

// ── Types ────────────────────────────────────────────────────
export interface JitoSubmissionError {
  code: number;
  message: string;
  isLeaderSkipped: boolean;
}

// ── Fetch live tip accounts from Jito ────────────────────────
export async function getTipAccounts(): Promise<string[]> {
  try {
    const res = await fetch(`${JITO_BLOCK_ENGINE_URL}/api/v1/bundles/tip_accounts`, {
      signal: AbortSignal.timeout(6_000),
    });

    if (!res.ok) {
      throw new Error(`Jito tip accounts API returned ${res.status}`);
    }

    const data: any = await res.json();
    const accounts: string[] = Array.isArray(data as any) ? data : (data.accounts ?? []);

    if (accounts.length === 0) throw new Error("Empty tip accounts list from Jito");

    console.log(`[JITO] Fetched ${accounts.length} live tip accounts`);
    return accounts;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[JITO] Could not fetch live tip accounts (${msg}), using known devnet accounts`);
    return KNOWN_DEVNET_TIP_ACCOUNTS;
  }
}

// ── Pick a random tip account ─────────────────────────────────
export async function getRandomTipAccount(): Promise<PublicKey> {
  const accounts = await getTipAccounts();
  const chosen = accounts[Math.floor(Math.random() * accounts.length)];
  return new PublicKey(chosen);
}

// ── Build and submit a Jito bundle ────────────────────────────
// The bundle contains exactly 2 transactions:
//   [0] the user's actual transaction
//   [1] the tip transfer instruction
// Jito requires the tip tx to be last in the bundle.
export async function buildAndSubmitBundle(
  connection: Connection,
  transaction: Transaction,
  payer: Keypair,
  tipLamports: number,
  tipAccount: PublicKey,
): Promise<BundleSubmissionResult> {
  let submissionSlot = 0;

  try {
    submissionSlot = await connection.getSlot("confirmed");
  } catch (_) {
    /* non-fatal — slot recorded as 0 */
  }

  // ── Build the tip transaction ─────────────────────────────
  const tipTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey:   tipAccount,
      lamports:   tipLamports,
    }),
  );

  // Set recent blockhash on both transactions
  let blockhash: string;
  let lastValidBlockHeight: number;
  try {
    const bh = await connection.getLatestBlockhash("confirmed");
    blockhash             = bh.blockhash;
    lastValidBlockHeight  = bh.lastValidBlockHeight;
  } catch (err: unknown) {
    throw new Error(`Failed to fetch blockhash for bundle: ${(err as Error).message}`);
  }

  transaction.recentBlockhash = blockhash;
  transaction.feePayer        = payer.publicKey;
  transaction.sign(payer);

  tipTx.recentBlockhash = blockhash;
  tipTx.feePayer        = payer.publicKey;
  tipTx.sign(payer);

  // ── Serialize both transactions ───────────────────────────
  const serializedTxs = [
    transaction.serialize().toString("base64"),
    tipTx.serialize().toString("base64"),
  ];

  // ── Submit bundle to Jito block engine ───────────────────
  console.log(
    `[JITO] Submitting bundle — tip: ${tipLamports} lamports` +
    ` → ${tipAccount.toBase58().slice(0, 12)}... slot: ${submissionSlot}`,
  );

  let bundleResponse: Response;
  try {
    bundleResponse = await fetch(JITO_BUNDLES_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id:      1,
        method:  "sendBundle",
        params:  [serializedTxs],
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[JITO] Bundle engine unreachable: ${msg} — falling back to standard submission`);
    return fallbackSubmit(connection, transaction, payer, submissionSlot);
  }

  const responseData: any = await bundleResponse.json();

  // ── Handle Jito RPC errors ────────────────────────────────
  if (responseData.error) {
    const jitoErr = parseJitoError(responseData.error);

    if (jitoErr.isLeaderSkipped) {
      console.error(`[JITO] Leader skipped slot! Surfacing as JitoLeaderSkipped`);
      return {
        bundle_id:       "",
        submission_slot: submissionSlot,
        success:         false,
        error:           TransactionFailure.JitoLeaderSkipped,
        used_fallback:   false,
      };
    }

    // Non-recoverable Jito error — fall back to standard submission
    console.warn(`[JITO] Bundle error (${jitoErr.message}) — falling back to standard submission`);
    return fallbackSubmit(connection, transaction, payer, submissionSlot);
  }

  const bundleId: string = responseData.result ?? "";
  console.log(`[JITO] Bundle accepted — bundleId: ${bundleId} slot: ${submissionSlot}`);

  return {
    bundle_id:       bundleId,
    submission_slot: submissionSlot,
    success:         true,
    used_fallback:   false,
  };
}

// ── Fallback: standard sendRawTransaction ────────────────────
async function fallbackSubmit(
  connection: Connection,
  transaction: Transaction,
  payer: Keypair,
  submissionSlot: number,
): Promise<BundleSubmissionResult> {
  console.warn("[JITO] FALLBACK — submitting via standard sendRawTransaction (no Jito bundle)");

  try {
    // Re-sign with a fresh blockhash since the bundle path may have taken time
    const bh = await connection.getLatestBlockhash("confirmed");
    transaction.recentBlockhash = bh.blockhash;
    transaction.feePayer        = payer.publicKey;
    transaction.sign(payer);

    const rawTx     = transaction.serialize();
    const signature = await connection.sendRawTransaction(rawTx, {
      skipPreflight:       false,
      preflightCommitment: "confirmed",
    });

    console.log(`[JITO] Fallback submission sent — sig: ${signature.slice(0, 12)}...`);

    return {
      bundle_id:       signature, // use sig as pseudo bundle_id in fallback
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
  const message       = error.message ?? "Unknown Jito error";
  const code          = error.code    ?? -1;
  const isLeaderSkipped =
    message.toLowerCase().includes("leader") &&
    message.toLowerCase().includes("skip");

  return { code, message, isLeaderSkipped };
}
