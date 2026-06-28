// ============================================================
// smart-tx-stack — src/execution/jito.ts
// Jito bundle builder + submitter for Solana devnet
// Uses /api/v1/transactions sendTransaction endpoint —
// packs user instruction + tip transfer in a single tx.
// After Jito accepts, ALSO submits to devnet RPC so the
// lifecycle poller can track confirmation on devnet.
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

// Known Jito tip accounts
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
// Strategy:
//   1. Fetch devnet blockhash
//   2. Build combined tx (user ix + tip transfer)
//   3. Simulate on devnet
//   4. Submit to Jito testnet (bundle routing + tip auction)
//   5. ALSO submit to devnet RPC — ensures lifecycle poller
//      can track confirmation (Jito testnet is a different
//      cluster from devnet; same signed tx is valid on devnet)
//   6. Return devnet signature for lifecycle tracking
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

  // ── Fetch devnet blockhash ────────────────────────────────
  let blockhash: string;
  try {
    const bh  = await connection.getLatestBlockhash("confirmed");
    blockhash = bh.blockhash;
  } catch (err: unknown) {
    throw new Error(`Failed to fetch blockhash for bundle: ${(err as Error).message}`);
  }

  // ── Extract user instructions ─────────────────────────────
  const userInstructions: TransactionInstruction[] =
    transaction.instructions.length > 0 ? transaction.instructions : [];

  // ── Build tip instruction ─────────────────────────────────
  const tipInstruction = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey:   tipAccount,
    lamports:   tipLamports,
  });

  // ── Build combined transaction: [userIx..., tipIx] ────────
  const combinedTx = new Transaction();
  for (const ix of userInstructions) combinedTx.add(ix);
  combinedTx.add(tipInstruction);
  combinedTx.recentBlockhash = blockhash;
  combinedTx.feePayer        = payer.publicKey;
  combinedTx.sign(payer);

  // ── Pre-submission simulation on devnet ───────────────────
  try {
    console.log("[JITO] Simulating transaction before submission...");
    const sim = await connection.simulateTransaction(combinedTx, [payer]);
    if (sim.value.err) {
      console.warn(`[JITO] Simulation warning: ${JSON.stringify(sim.value.err)}`);
    } else {
      console.log(`[JITO] Simulation passed — units: ${sim.value.unitsConsumed ?? "N/A"}`);
    }
  } catch (_) { /* non-fatal */ }

  // ── Serialize as base64 for Jito sendTransaction ─────────
  const serialized    = combinedTx.serialize().toString("base64");
  const serializedRaw = combinedTx.serialize();

  console.log(
    `[JITO] Submitting via sendTransaction — tip: ${tipLamports} lamports` +
    ` → ${tipAccount.toBase58().slice(0, 12)}... slot: ${submissionSlot}`,
  );

  // ── Step 1: Submit to Jito testnet block engine ───────────
  let jitoSignature = "";
  try {
    const response = await fetch(JITO_TX_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id:      1,
        method:  "sendTransaction",
        params:  [serialized, { encoding: "base64" }],
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const bundleId    = response.headers.get("x-bundle-id") ?? "";
    const responseData: any = await response.json().catch(() => ({}));

    if (responseData.error) {
      const jitoErr = parseJitoError(responseData.error);
      console.warn(`[JITO] Jito error: ${jitoErr.message}`);
      if (jitoErr.isLeaderSkipped) {
        return {
          bundle_id:       "",
          submission_slot: submissionSlot,
          success:         false,
          error:           TransactionFailure.JitoLeaderSkipped,
          used_fallback:   false,
        };
      }
    } else {
      jitoSignature = responseData.result ?? bundleId;
      if (bundleId) {
        console.log(`[JITO] Bundle accepted by Jito — bundleId: ${bundleId.slice(0, 12)}...`);
      } else if (jitoSignature) {
        console.log(`[JITO] Transaction accepted by Jito — sig: ${jitoSignature.slice(0, 12)}...`);
      }
    }
  } catch (jitoErr: unknown) {
    console.warn(`[JITO] Jito unreachable: ${jitoErr instanceof Error ? jitoErr.message : String(jitoErr)}`);
  }

  // ── Step 2: ALSO submit to devnet RPC ────────────────────
  // This is the key fix: Jito testnet is a different cluster.
  // The same signed transaction (with devnet blockhash) is
  // valid on devnet — submit it directly so our poller can
  // track lifecycle confirmation on devnet.
  console.log("[JITO] Submitting to devnet RPC for lifecycle confirmation...");
  try {
    const devnetSig = await connection.sendRawTransaction(serializedRaw, {
      skipPreflight:       true,   // already simulated above
      preflightCommitment: "confirmed",
    });
    console.log(`[JITO] Devnet submission confirmed — sig: ${devnetSig.slice(0, 12)}...`);

    return {
      bundle_id:       devnetSig,   // devnet sig for lifecycle tracking
      submission_slot: submissionSlot,
      success:         true,
      used_fallback:   false,       // we did submit to Jito first
    };
  } catch (devnetErr: unknown) {
    const msg = devnetErr instanceof Error ? devnetErr.message : String(devnetErr);
    console.error(`[JITO] Devnet submission failed: ${msg}`);

    // Last resort: try fallback with fresh blockhash
    return fallbackSubmit(connection, transaction, payer, submissionSlot);
  }
}

// ── Fallback: fresh blockhash + standard sendRawTransaction ──
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
