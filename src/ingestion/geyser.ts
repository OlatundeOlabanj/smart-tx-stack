// ============================================================
// smart-tx-stack — src/ingestion/geyser.ts
// Yellowstone gRPC stream via SolInfra — PERSISTENT connection
// FIX: correct signature extraction paths for Yellowstone v4
// Path 1: txData.transaction.signature (direct bytes — v4+)
// Path 2: txData.transaction.transaction.signatures[0] (nested)
// Made by TJS Code
// ============================================================

import Client, { CommitmentLevel } from "@triton-one/yellowstone-grpc";

const GRPC_ENDPOINT = process.env.SOLINFRA_GRPC_ENDPOINT ?? "https://fra.grpc.solinfra.dev:443";
const GRPC_TOKEN    = process.env.SOLINFRA_GRPC_KEY ?? "";

let geyserAvailable = false;
let latestSlot      = 0;
let geyserStream:   any = null;
let geyserClient:   any = null;
let txEventCount    = 0;  // debug counter

const pendingGeyserConfirms = new Map<string, (slot: number) => void>();
const geyserConfirmedSigs   = new Set<string>();

export function isGeyserAvailable(): boolean  { return geyserAvailable; }
export function getLatestGeyserSlot(): number { return latestSlot; }
export function wasConfirmedViaGeyser(sig: string): boolean {
  return geyserConfirmedSigs.has(sig);
}

export function watchForGeyserConfirmation(
  signature: string,
  callback: (slot: number) => void,
): void {
  if (!geyserAvailable || !geyserStream) return;
  pendingGeyserConfirms.set(signature, callback);
  console.log(`[GEYSER] Watching for: ${signature.slice(0, 12)}...`);
}

export async function subscribeToWalletTransactions(walletPubkey: string): Promise<void> {
  if (!geyserAvailable || !geyserStream) {
    console.warn("[GEYSER] Cannot subscribe to wallet — stream not active");
    return;
  }
  console.log(`[GEYSER] Subscribing to wallet txns: ${walletPubkey.slice(0, 12)}...`);
  await new Promise<void>((resolve) => {
    geyserStream.write(
      {
        slots:       { incoming_slots: {} },
        accounts:    {},
        transactions: {
          "smart-tx-wallet": {
            vote:            false,
            failed:          false,
            accountInclude:  [walletPubkey],
            accountExclude:  [],
            accountRequired: [],
          },
        },
        transactionsStatus: {},
        blocks:      {},
        blocksMeta:  {},
        entry:       {},
        accountsDataSlice: [],
        commitment:  CommitmentLevel.CONFIRMED,
      },
      (err: Error | null | undefined) => {
        if (err) console.warn(`[GEYSER] Wallet subscribe error: ${err.message}`);
        else     console.log("[GEYSER] Wallet transaction subscription active");
        resolve();
      },
    );
  });
}

// ── Extract signature bytes — tries all known Yellowstone paths ──
function extractSigBytes(txData: any): Buffer | null {
  try {
    // Path 1 — Direct signature field on SubscribeUpdateTransactionInfo (Yellowstone v4+)
    // data.transaction.transaction.signature (bytes)
    const p1 = txData?.transaction?.signature;
    if (p1 && p1.length > 0) {
      return Buffer.isBuffer(p1) ? p1 : Buffer.from(p1);
    }

    // Path 2 — Nested SolanaTransaction.signatures array
    // data.transaction.transaction.transaction.signatures[0]
    const p2 = txData?.transaction?.transaction?.signatures?.[0];
    if (p2 && p2.length > 0) {
      return Buffer.isBuffer(p2) ? p2 : Buffer.from(p2);
    }

    // Path 3 — Top-level signature on txData directly (some client versions)
    const p3 = txData?.signature;
    if (p3 && p3.length > 0) {
      return Buffer.isBuffer(p3) ? p3 : Buffer.from(p3);
    }

    return null;
  } catch {
    return null;
  }
}

function handleStreamData(data: any): void {
  // ── Slot updates ────────────────────────────────────────────
  if (data?.slot) {
    const slot = Number(data.slot.slot);
    if (!geyserAvailable) {
      geyserAvailable = true;
      console.log(`[GEYSER] Connected — first slot: ${slot}`);
    }
    latestSlot = Math.max(latestSlot, slot);
    return;
  }

  // ── Transaction events ──────────────────────────────────────
  if (data?.transaction) {
    txEventCount++;
    const txData = data.transaction;
    const slot   = Number(txData?.slot ?? 0);

    // Debug: log structure of first 3 transaction events to understand the shape
    if (txEventCount <= 3) {
      const topKeys  = Object.keys(txData ?? {}).join(",");
      const txKeys   = Object.keys(txData?.transaction ?? {}).join(",");
      console.log(`[GEYSER] TX event #${txEventCount} — txData keys: [${topKeys}] tx keys: [${txKeys}]`);
    }

    const sigBuf = extractSigBytes(txData);
    if (!sigBuf || slot === 0) return;

    const sig = bs58Encode(sigBuf);
    if (!sig) return;

    if (pendingGeyserConfirms.has(sig)) {
      console.log(`[GEYSER] Confirmed via stream: ${sig.slice(0, 12)}... slot: ${slot}`);
      geyserConfirmedSigs.add(sig);
      const callback = pendingGeyserConfirms.get(sig)!;
      pendingGeyserConfirms.delete(sig);
      callback(slot);
    }
  }
}

// ── Lightweight base58 encoder ────────────────────────────────
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58Encode(buf: Buffer): string {
  if (buf.length === 0) return "";
  let carry: number;
  const digits: number[] = [0];
  for (let i = 0; i < buf.length; i++) {
    carry = buf[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let str = "";
  for (let k = 0; buf[k] === 0 && k < buf.length - 1; k++) str += "1";
  for (let k = digits.length - 1; k >= 0; k--) str += ALPHABET[digits[k]];
  return str;
}

export async function initGeyser(): Promise<void> {
  if (!GRPC_TOKEN) {
    console.warn("[GEYSER] No SOLINFRA_GRPC_KEY — gRPC streaming disabled");
    return;
  }
  console.log("[GEYSER] Initialising Yellowstone gRPC stream via SolInfra...");
  try {
    geyserClient = new Client(GRPC_ENDPOINT, GRPC_TOKEN, undefined);
    geyserStream = await geyserClient.subscribe();

    geyserStream.on("data",  handleStreamData);
    geyserStream.on("error", (err: Error) => {
      console.warn(`[GEYSER] Stream error: ${err.message}`);
      geyserAvailable = false;
    });
    geyserStream.on("end", () => {
      console.log("[GEYSER] Stream ended");
      geyserAvailable = false;
    });

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (geyserAvailable) console.log(`[GEYSER] Warmup complete — slot: ${latestSlot}`);
        else                  console.warn("[GEYSER] Warmup timeout — no slot updates received");
        resolve();
      }, 5_000);

      geyserStream.write(
        {
          slots:             { incoming_slots: {} },
          accounts:          {},
          transactions:      {},
          transactionsStatus:{},
          blocks:            {},
          blocksMeta:        {},
          entry:             {},
          accountsDataSlice: [],
          commitment:        CommitmentLevel.CONFIRMED,
        },
        (err: Error | null | undefined) => {
          if (err) {
            clearTimeout(timeout);
            console.warn(`[GEYSER] Initial subscribe error: ${err.message}`);
            geyserAvailable = false;
            resolve();
          }
        },
      );
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[GEYSER] Could not connect: ${msg} — falling back to RPC polling`);
    geyserAvailable = false;
  }
}

export function closeGeyser(): void {
  if (geyserStream) {
    try { geyserStream.end(); } catch { /* already closed */ }
    geyserStream = null;
  }
  geyserAvailable = false;
  console.log("[GEYSER] Stream closed");
}
