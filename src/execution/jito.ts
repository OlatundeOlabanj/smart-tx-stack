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
} from "@solana/web3.js";
import bs58 from "bs58";
import { BundleSubmissionResult, TransactionFailure } from "../types";

// ── Jito devnet block engine endpoint ────────────────────────
// NOTE: dallas.devnet (not testnet) for devnet submissions
const JITO_BLOCK_ENGINE_URL = "https://dallas.devnet.block-engine.jito.wtf";
const JITO_BUNDLES_URL      = `${JITO_BLOCK_ENGINE_URL}/api/v1/bundles`;

// Known devnet tip accounts
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
    console.warn(`[JITO] Could not fetch live tip accounts (${msg}), using known devnet accounts`);
    return KNOWN_DEVNET_TIP_ACCOUNTS;
  }
}

export async function getRandomTipAccount(): Promise<PublicKey> {
  const accounts = await getTipAccounts();
  const chosen   = accounts[Math.floor(Math.random() * accounts.length)];
  return new PublicKey(chosen);
}

// ── Build and submit a Jito bundle ────────────────────────────
// Bundle = [userTx, tipTx] serialized as base58 strings
// Jito block engine requires base58 — NOT base64
export async function buildAndSubmitBundle(
  connection:   Connection,
  transaction:  Transaction,
  payer:        Keypair,
  tipLamports:  number,
  tipAccount:   PublicKey,
): Promise<BundleSubmissionResult> {
  let submissionSlot = 0;
  try {
    submissionSlot = await connection.getSlot("confirmed");
  } catch (_) { /* non-fatal */ }

  // ── Fetch blockhash ───────────────────────────────────────
  let blockhash: string;
  try {
    const bh     = await connection.getLatestBlockhash("confirmed");
    blockhash    = bh.blockhash;
  } catch (err: unknown) {
    throw new Error(`Failed to fetch blockhash for bundle: ${(err as Error).message}`);
  }

  // ── Build user transaction ────────────────────────────────
  transaction.recentBlockhash = blockhash;
  transaction.feePayer        = payer.publicKey;
  transaction.sign(payer);

  // ── Build tip transaction ─────────────────────────────────
  const tipTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey:   tipAccount,
      lamports:   tipLamports,
    }),
  );
  tipTx.recentBlockhash = blockhash;
  tipTx.feePayer        = payer.publicKey;
  tipTx.sign(payer);

  // ── Serialize as base58 (Jito requirement) ────────────────
  // base64 causes "transaction #0 could not be decoded" error
  const serializedTxs = [
    bs58.encode(transaction.serialize()),
    bs58.encode(tipTx.serialize()),
  ];

  console.log(
    `[JITO] Submitting bundle — tip: ${tipLamports} lamports` +
    ` → ${tipAccount.toBase58().slice(0, 12)}... slot: ${submissionSlot}`,
  );

  // ── POST to Jito block engine ─────────────────────────────
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
    console.warn(`[JITO] Bundle engine unreachable: ${msg} — falling back`);
    return fallbackSubmit(connection, transaction, payer, submissionSlot);
  }

  const responseData: any = await bundleResponse.json();

  if (responseData.error) {
    const jitoErr = parseJitoError(responseData.error);
    if (jitoErr.isLeaderSkipped) {
      console.error(`[JITO] Leader skipped slot — surfacing as JitoLeaderSkipped`);
      return {
        bundle_id:       "",
        submission_slot: submissionSlot,
        success:         false,
        error:           TransactionFailure.JitoLeaderSkipped,
        used_fallback:   false,
      };
    }
    console.warn(`[JITO] Bundle error (${jitoErr.message}) — falling back`);
    return fallbackSubmit(connection, transaction, payer, submissionSlot);
  }

  const bundleId: string = responseData.result ?? "";
  console.log(`[JITO] Bundle accepted — bundleId: ${bundleId.slice(0, 12)}... slot: ${submissionSlot}`);

  return {
    bundle_id:       bundleId,
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
  console.warn("[JITO] FALLBACK — submitting via standard sendRawTransaction (no Jito bundle)");
  try {
    const bh                    = await connection.getLatestBlockhash("confirmed");
    transaction.recentBlockhash = bh.blockhash;
    transaction.feePayer        = payer.publicKey;
    transaction.sign(payer);

    const signature = await connection.sendRawTransaction(
      transaction.serialize(),
      { skipPreflight: false, preflightCommitment: "confirmed" },
    );
    console.log(`[JITO] Fallback submission sent — sig: ${signature.slice(0, 12)}...`);
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
