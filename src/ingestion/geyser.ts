// ============================================================
// smart-tx-stack — src/ingestion/geyser.ts
// Yellowstone gRPC stream via SolInfra
// Monitors slot updates and transaction confirmations in real time
// Falls back gracefully if gRPC unavailable
// Made by TJS Code
// ============================================================

import Client, {
  CommitmentLevel,
  SubscribeRequestFilterSlots,
  SubscribeRequestFilterTransactions,
} from "@triton-one/yellowstone-grpc";

const GRPC_ENDPOINT = process.env.SOLINFRA_GRPC_ENDPOINT ?? "fra.grpc.solinfra.dev:443";
const GRPC_TOKEN    = process.env.SOLINFRA_GRPC_KEY ?? "";

export interface SlotUpdate {
  slot:   number;
  status: "processed" | "confirmed" | "finalized";
}

export interface GeyserTransactionUpdate {
  signature: string;
  slot:      number;
  err:       boolean;
}

export type SlotCallback        = (update: SlotUpdate) => void;
export type TransactionCallback = (update: GeyserTransactionUpdate) => void;

let geyserAvailable = false;
let latestSlot      = 0;

export function isGeyserAvailable(): boolean { return geyserAvailable; }
export function getLatestGeyserSlot(): number { return latestSlot; }

export async function subscribeSlots(onSlot: SlotCallback, durationMs = 30_000): Promise<void> {
  if (!GRPC_TOKEN) { console.warn("[GEYSER] SOLINFRA_GRPC_KEY not set — skipping slot stream"); return; }
  try {
    const client = new Client(GRPC_ENDPOINT, GRPC_TOKEN, undefined);
    await client.connect();
    const stream = await client.subscribe();
    geyserAvailable = true;
    console.log(`[GEYSER] Connected to Yellowstone gRPC — ${GRPC_ENDPOINT}`);
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { console.log(`[GEYSER] Slot stream closed after ${durationMs}ms`); resolve(); }, durationMs);
      stream.on("data", (data: any) => {
        if (data?.slot) {
          const slot = Number(data.slot.slot);
          const status = commitmentToStatus(data.slot.status);
          latestSlot = Math.max(latestSlot, slot);
          onSlot({ slot, status });
        }
      });
      stream.on("error", (err: Error) => { clearTimeout(timeout); console.warn(`[GEYSER] Stream error: ${err.message}`); geyserAvailable = false; resolve(); });
      stream.on("end", () => { clearTimeout(timeout); resolve(); });
      stream.write({ slots: { default: { filterByCommitment: true } }, accounts: {}, transactions: {}, blocks: {}, blocksMeta: {}, accountsDataSlice: [], commitment: CommitmentLevel.CONFIRMED }, (err: Error | null | undefined) => {
        if (err) { clearTimeout(timeout); console.warn(`[GEYSER] Write error: ${err.message}`); geyserAvailable = false; resolve(); }
      });
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[GEYSER] Could not connect: ${msg}`);
    console.warn("[GEYSER] Falling back to RPC polling");
    geyserAvailable = false;
  }
}

export async function initGeyser(): Promise<void> {
  if (!GRPC_TOKEN) { console.warn("[GEYSER] No SOLINFRA_GRPC_KEY — gRPC streaming disabled"); return; }
  console.log("[GEYSER] Initialising Yellowstone gRPC stream...");
  let slotsReceived = 0;
  await subscribeSlots((update) => {
    if (slotsReceived === 0) console.log(`[GEYSER] First slot from stream — slot: ${update.slot} status: ${update.status}`);
    slotsReceived++;
    latestSlot = Math.max(latestSlot, update.slot);
  }, 5_000);
  if (geyserAvailable) {
    console.log(`[GEYSER] Warmup complete — received ${slotsReceived} slot updates. Latest slot: ${latestSlot}`);
  } else {
    console.warn("[GEYSER] gRPC unavailable — system will use RPC polling only");
  }
}

function commitmentToStatus(status: number): "processed" | "confirmed" | "finalized" {
  switch (status) { case 0: return "processed"; case 1: return "confirmed"; case 2: return "finalized"; default: return "confirmed"; }
}
