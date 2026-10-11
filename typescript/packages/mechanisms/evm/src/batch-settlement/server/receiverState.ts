import type { Network } from "@x402/core/types";
import { getAddress } from "viem";
import { batchSettlementABI } from "../abi";
import { BATCH_SETTLEMENT_ADDRESS } from "../constants";

/**
 * The only account triple a channel manager may settle.
 * `receiver` is the scheme payTo. `token` and `network` are the manager's own.
 */
export interface ReceiverSettlementScope {
  network: Network;
  receiver: `0x${string}`;
  token: `0x${string}`;
}

/**
 * On-chain `receivers(receiver, token)` totals for one scope.
 * Pending funds are `totalClaimed - totalSettled`. A zero difference is not a settle.
 */
export interface ReceiverSettlementSnapshot extends ReceiverSettlementScope {
  totalClaimed: bigint;
  totalSettled: bigint;
}

/**
 * Reads claimed and settled totals for one receiver and token.
 * Implementations must return the scope they actually read.
 */
export type ReadReceiverSettlement = (
  scope: ReceiverSettlementScope,
) => Promise<ReceiverSettlementSnapshot>;

interface ReceiverStateClient {
  chain?: { id: number };
  getChainId: () => Promise<number>;
  readContract: (args: {
    address: `0x${string}`;
    abi: typeof batchSettlementABI;
    functionName: "receivers";
    args: readonly [`0x${string}`, `0x${string}`];
  }) => Promise<readonly [bigint, bigint]>;
}

/** Canonical unsigned decimal chain id. `eip155:0` is included. Leading zeros are not. */
const CANONICAL_UNSIGNED_EIP155 = /^eip155:(0|[1-9][0-9]*)$/;

/**
 * Parses the chain id this reader may use for an unsigned EVM scope.
 *
 * The reference must be a canonical decimal integer in the safe-integer range.
 * Empty, signed, hex, exponent, whitespace, leading-zero, and unsafe references
 * are rejected before a contract read. This does not change global CAIP-2 parsing.
 *
 * @param network - Caller-supplied network for the receiver scope.
 * @returns The chain id to compare with the public client.
 */
export function unsignedEip155ChainId(network: string): number {
  const match = CANONICAL_UNSIGNED_EIP155.exec(network);
  if (!match) {
    throw new Error(
      `pending settlement observation requires a canonical unsigned eip155 network, received ${network}`,
    );
  }
  const chainId = BigInt(match[1]);
  if (chainId > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `pending settlement observation requires a canonical unsigned eip155 network, received ${network}`,
    );
  }
  return Number(chainId);
}

/**
 * Checks that a scoped read returned non-negative bigint totals.
 *
 * @param totalClaimed - Claimed total from the snapshot or contract read.
 * @param totalSettled - Settled total from the snapshot or contract read.
 * @returns The same totals once they are safe to compare.
 */
export function assertReceiverSettlementTotals(
  totalClaimed: unknown,
  totalSettled: unknown,
): { totalClaimed: bigint; totalSettled: bigint } {
  if (typeof totalClaimed !== "bigint" || typeof totalSettled !== "bigint") {
    throw new Error("pending settlement observation returned a non-bigint total");
  }
  if (totalClaimed < 0n || totalSettled < 0n) {
    throw new Error("pending settlement observation returned a negative total");
  }
  if (totalSettled > totalClaimed) {
    throw new Error("settled amount exceeds claimed amount for this receiver and token");
  }
  return { totalClaimed, totalSettled };
}

/**
 * Reads `x402BatchSettlement.receivers(payTo, token)` on the public client.
 *
 * The read is not a settle transaction. Both the configured client chain id and
 * the independently queried RPC chain id must match the canonical unsigned
 * `eip155` network. The contract function returns
 * `(totalClaimed, totalSettled)` for that pair only; other receivers and tokens
 * are not queried. A negative, non-bigint, or settled-above-claimed result
 * cannot be used to authorize settle.
 *
 * @param publicClient - Client bound to the manager's chain.
 * @param scope - Network, payTo, and token the manager is allowed to settle.
 * @returns The totals stored for that pair.
 */
export async function readBatchSettlementReceiverState(
  publicClient: ReceiverStateClient,
  scope: ReceiverSettlementScope,
): Promise<ReceiverSettlementSnapshot> {
  const chainId = unsignedEip155ChainId(scope.network);
  if (publicClient.chain?.id !== chainId) {
    throw new Error(
      `public client chain ${publicClient.chain?.id ?? "unknown"} does not match ${scope.network}`,
    );
  }

  // Configuration names the intended network; the RPC independently proves the
  // network actually serving the observation. Metadata alone cannot authorize a noop.
  if (typeof publicClient.getChainId !== "function") {
    throw new Error("pending settlement observation requires an independent RPC chain id");
  }
  const connectedChainId = await publicClient.getChainId();
  if (connectedChainId !== chainId) {
    throw new Error(`connected RPC chain ${connectedChainId} does not match ${scope.network}`);
  }

  const receiver = getAddress(scope.receiver);
  const token = getAddress(scope.token);
  const [totalClaimed, totalSettled] = await publicClient.readContract({
    address: getAddress(BATCH_SETTLEMENT_ADDRESS),
    abi: batchSettlementABI,
    functionName: "receivers",
    args: [receiver, token],
  });
  const totals = assertReceiverSettlementTotals(totalClaimed, totalSettled);

  return {
    network: scope.network,
    receiver,
    token,
    totalClaimed: totals.totalClaimed,
    totalSettled: totals.totalSettled,
  };
}
