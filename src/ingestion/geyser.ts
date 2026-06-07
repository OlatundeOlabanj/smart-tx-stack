// ============================================================
// smart-tx-stack — src/ingestion/geyser.ts
// Yellowstone gRPC stream via SolInfra (v5 API)
// Made by TJS Code
// ============================================================

import Client, { CommitmentLevel } from "@triton-one/yellowstone-grpc";

const GRPC_ENDPOINT = process.env.SOLINFRA_GRPC_ENDPOINT ?? "fra.grpc.solinfra.dev:443";
const GRPC_TOKEN    = process.env.SOLINFRA_GRPC_KEY ?? "";

export interface SlotUpdate {
  slot:   number;
  status: "processed" | "confirmed" | "finalized";
}

let geyserAvailable = false;
let latestSlot      = 0;

export function isGeyserAvailable(): boolean { return geyserAvailable; }
export function getLatestGeyserSlot(): number { return latestSlot; }

export async function initGeyser(): Promise<void> {
  if (!GRPC_TOKEN) {
    console.warn("[GEYSER] No SOLINFRA_GRPC_KEY — gRPC streaming disabled");
    return;
  }

  console.log("[GEYSER] Initialising Yellowstone gRPC stream...");

  try {
    // v5 API — pass token as third arg (x-token header)
    const client = new Client(GRPC_ENDPOINT, GRPC_TOKEN, undefined); // auth via token arg
    // Channel options below (x-token not needed as separate header)

    await client.connect();
    const stream = await client.subscribe();

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.log("[GEYSER] Warmup complete — closing init stream");
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
        resolve();
      });

      // Subscribe to slot updates (v5 camelCase format)
      const req = {
        slots: { incoming_slots: {} },
        accounts: {},
        transactions: {},
        transactionsStatus: {},
        blocks: {},
        blocksMeta: {},
        entry: {},
        accountsDataSlice: [],
        commitment: CommitmentLevel.CONFIRMED,
        ping: undefined,
      };

      stream.write(req, (err: Error | null | undefined) => {
        if (err) {
          clearTimeout(timeout);
          console.warn(`[GEYSER] Subscribe write error: ${err.message}`);
          geyserAvailable = false;
          resolve();
        }
      });
    });

    if (geyserAvailable) {
      console.log(`[GEYSER] Stream active — latest slot: ${latestSlot}`);
    } else {
      console.warn("[GEYSER] Could not connect: failed to connect to gRPC endpoint");
      console.warn("[GEYSER] Falling back to RPC polling");
    }

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[GEYSER] Could not connect: ${msg}`);
    console.warn("[GEYSER] Falling back to RPC polling");
    geyserAvailable = false;
  }
}