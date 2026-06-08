// ============================================================
// smart-tx-stack — src/ingestion/geyser.ts
// Yellowstone gRPC stream via SolInfra (v4.0.2 API)
// Made by TJS Code
// ============================================================

import Client, { CommitmentLevel } from "@triton-one/yellowstone-grpc";

const GRPC_ENDPOINT = process.env.SOLINFRA_GRPC_ENDPOINT ?? "https://fra.grpc.solinfra.dev:443";
const GRPC_TOKEN    = process.env.SOLINFRA_GRPC_KEY ?? "";

let geyserAvailable = false;
let latestSlot      = 0;

export function isGeyserAvailable(): boolean { return geyserAvailable; }
export function getLatestGeyserSlot(): number { return latestSlot; }

export async function initGeyser(): Promise<void> {
  if (!GRPC_TOKEN) {
    console.warn("[GEYSER] No SOLINFRA_GRPC_KEY — gRPC streaming disabled");
    return;
  }

  console.log("[GEYSER] Initialising Yellowstone gRPC stream via SolInfra...");

  try {
    // v4 API — no connect() call needed, subscribe directly
    const client = new Client(GRPC_ENDPOINT, GRPC_TOKEN, undefined);
    const stream  = await client.subscribe();

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.log(`[GEYSER] Warmup complete — latest slot: ${latestSlot}`);
        stream.end();
        resolve();
      }, 5_000);

      stream.on("data", (data: any) => {
        if (data?.slot) {
          const slot = Number(data.slot.slot);
          if (!geyserAvailable) {
            geyserAvailable = true;
            console.log(`[GEYSER] Connected to Yellowstone gRPC — first slot: ${slot}`);
          }
          latestSlot = Math.max(latestSlot, slot);
        }
      });

      stream.on("error", (err: Error) => {
        clearTimeout(timeout);
        console.warn(`[GEYSER] Stream error: ${err.message}`);
        console.warn("[GEYSER] Falling back to RPC polling");
        geyserAvailable = false;
        resolve();
      });

      stream.on("end", () => {
        clearTimeout(timeout);
        if (geyserAvailable) {
          console.log(`[GEYSER] Stream active — latest slot: ${latestSlot}`);
        }
        resolve();
      });

      // Subscribe to slot updates
      stream.write({
        slots: { incoming_slots: {} },
        accounts: {},
        transactions: {},
        transactionsStatus: {},
        blocks: {},
        blocksMeta: {},
        entry: {},
        accountsDataSlice: [],
        commitment: CommitmentLevel.CONFIRMED,
      }, (err: Error | null | undefined) => {
        if (err) {
          clearTimeout(timeout);
          console.warn(`[GEYSER] Subscribe write error: ${err.message}`);
          geyserAvailable = false;
          resolve();
        }
      });
    });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[GEYSER] Could not connect: ${msg}`);
    console.warn("[GEYSER] Falling back to RPC polling");
    geyserAvailable = false;
  }
}
