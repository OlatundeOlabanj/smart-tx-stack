// ============================================================
// smart-tx-stack — src/ingestion/geyser.ts
// Yellowstone gRPC stream via SolInfra — PERSISTENT connection
// Subscribes to wallet account transactions, confirms them
// via gRPC stream and tags entries as confirmed_via: "geyser"
// Made by TJS Code
// ============================================================

import Client, { CommitmentLevel } from "@triton-one/yellowstone-grpc";

const GRPC_ENDPOINT = process.env.SOLINFRA_GRPC_ENDPOINT ?? "https://fra.grpc.solinfra.dev:443";
const GRPC_TOKEN    = process.env.SOLINFRA_GRPC_KEY ?? "";

let geyserAvailable = false;
let latestSlot      = 0;
let geyserStream:   any = null;
let geyserClient:   any = null;

// Signatures we are actively waiting to confirm via gRPC
const pendingGeyserConfirms = new Map<string, (slot: number) => void>();

// Signatures that were confirmed by the gRPC stream (not RPC polling)
const geyserConfirmedSigs = new Set<string>();

// ── Public state accessors ────────────────────────────────────
export function isGeyserAvailable(): boolean   { return geyserAvailable; }
export function getLatestGeyserSlot(): number  { return latestSlot; }
export function wasConfirmedViaGeyser(sig: string): boolean {
  return geyserConfirmedSigs.has(sig);
}

// ── Register a signature to be confirmed via gRPC stream ─────
export function watchForGeyserConfirmation(
  signature: string,
  callback: (slot: number) => void,
): void {
  if (!geyserAvailable || !geyserStream) return;
  pendingGeyserConfirms.set(signature, callback);
  console.log(`[GEYSER] Watching for: ${signature.slice(0, 12)}...`);
}

// ── Subscribe to all transactions for a specific wallet ───────
// Called after the wallet keypair is loaded in main()
export async function subscribeToWalletTransactions(walletPubkey: string): Promise<void> {
  if (!geyserAvailable || !geyserStream) {
    console.warn("[GEYSER] Cannot subscribe to wallet — stream not active");
    return;
  }

  console.log(`[GEYSER] Subscribing to wallet txns: ${walletPubkey.slice(0, 12)}...`);

  await new Promise<void>((resolve) => {
    geyserStream.write(
      {
        slots:            { incoming_slots: {} },
        accounts:         {},
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
        blocks:           {},
        blocksMeta:       {},
        entry:            {},
        accountsDataSlice: [],
        commitment:       CommitmentLevel.CONFIRMED,
      },
      (err: Error | null | undefined) => {
        if (err) {
          console.warn(`[GEYSER] Wallet subscribe write error: ${err.message}`);
        } else {
          console.log("[GEYSER] Wallet transaction subscription active");
        }
        resolve();
      },
    );
  });
}

// ── Handle incoming data from the persistent stream ───────────
function handleStreamData(data: any): void {
  // Slot updates — keep latestSlot current throughout the run
  if (data?.slot) {
    const slot = Number(data.slot.slot);
    if (!geyserAvailable) {
      geyserAvailable = true;
      console.log(`[GEYSER] Connected — first slot: ${slot}`);
    }
    latestSlot = Math.max(latestSlot, slot);
  }

  // Transaction confirmations from wallet subscription
  if (data?.transaction) {
    try {
      const txData  = data.transaction;
      const sigBytes = txData?.transaction?.transaction?.signatures?.[0];
      const slot     = Number(txData?.slot ?? 0);

      if (sigBytes && slot > 0) {
        // Convert signature bytes (Buffer/Uint8Array) to base58
        const sigBuf = Buffer.isBuffer(sigBytes)
          ? sigBytes
          : Buffer.from(sigBytes);

        // Base58 encode manually using the same alphabet Solana uses
        const sig = bs58Encode(sigBuf);

        if (sig && pendingGeyserConfirms.has(sig)) {
          console.log(`[GEYSER] Confirmed via stream: ${sig.slice(0, 12)}... slot: ${slot}`);
          geyserConfirmedSigs.add(sig);
          const callback = pendingGeyserConfirms.get(sig)!;
          pendingGeyserConfirms.delete(sig);
          callback(slot);
        }
      }
    } catch {
      // Malformed transaction data — skip
    }
  }
}

// ── Lightweight base58 encoder (avoids extra dep in geyser) ──
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

// ── Initialise geyser — creates persistent stream ─────────────
export async function initGeyser(): Promise<void> {
  if (!GRPC_TOKEN) {
    console.warn("[GEYSER] No SOLINFRA_GRPC_KEY — gRPC streaming disabled");
    return;
  }

  console.log("[GEYSER] Initialising Yellowstone gRPC stream via SolInfra...");

  try {
    geyserClient = new Client(GRPC_ENDPOINT, GRPC_TOKEN, undefined);
    geyserStream = await geyserClient.subscribe();

    // Attach data/error/end handlers before initial write
    geyserStream.on("data",  handleStreamData);

    geyserStream.on("error", (err: Error) => {
      console.warn(`[GEYSER] Stream error: ${err.message}`);
      geyserAvailable = false;
    });

    geyserStream.on("end", () => {
      console.log("[GEYSER] Stream ended");
      geyserAvailable = false;
    });

    // Initial subscribe to slot updates — confirms connectivity
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (geyserAvailable) {
          console.log(`[GEYSER] Warmup complete — slot: ${latestSlot}`);
        } else {
          console.warn("[GEYSER] Warmup timeout — no slot updates received");
        }
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
    console.warn(`[GEYSER] Could not connect: ${msg}`);
    console.warn("[GEYSER] Falling back to RPC polling");
    geyserAvailable = false;
  }
}

// ── Close the persistent stream at end of run ─────────────────
export function closeGeyser(): void {
  if (geyserStream) {
    try {
      geyserStream.end();
    } catch {
      // already closed
    }
    geyserStream = null;
  }
  geyserAvailable = false;
  console.log("[GEYSER] Stream closed");
}
