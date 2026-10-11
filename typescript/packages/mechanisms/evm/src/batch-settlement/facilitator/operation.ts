import type { SettleResponse } from "@x402/core/types";

/** One in-process batch operation; confirmed effects are never inferred from receiver totals. */
export interface BatchOperation {
  fingerprint: string;
  network: SettleResponse["network"];
  broadcastStarted: boolean;
  transaction?: string;
  confirm?: () => Promise<SettleResponse>;
  flight?: Promise<SettleResponse>;
}

/**
 * Stable wire comparison for the complete request and its accepted terms.
 * No new identifier, payment protocol, or signature format is introduced.
 *
 * @param value - JSON wire input.
 * @returns An order-independent representation.
 */
export function batchOperationFingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map(key => [key, item[key]]),
      );
    }
    return item;
  });
}
