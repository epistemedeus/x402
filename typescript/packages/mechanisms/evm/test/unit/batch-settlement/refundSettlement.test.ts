import { describe, it, expect, vi } from "vitest";
import type { MockedFunction } from "vitest";
import { getAddress } from "viem";
import { foundry } from "viem/chains";
import {
  BatchSettlementChannelManager,
  type SettleResult,
} from "../../../src/batch-settlement/server/channelManager";
import { BatchSettlementEvmScheme } from "../../../src/batch-settlement/server/scheme";
import { InMemoryChannelStorage, type Channel } from "../../../src/batch-settlement/server/storage";
import { readBatchSettlementReceiverState } from "../../../src/batch-settlement/server/receiverState";
import type {
  ReadReceiverSettlement,
  ReceiverSettlementScope,
  ReceiverSettlementSnapshot,
} from "../../../src/batch-settlement/server/receiverState";
import { computeChannelId as computeChannelIdForNetwork } from "../../../src/batch-settlement/utils";
import type { ChannelConfig } from "../../../src/batch-settlement/types";
import type { FacilitatorClient } from "@x402/core/server";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";

const RECEIVER = "0x9876543210987654321098765432109876543210" as `0x${string}`;
const OTHER_RECEIVER = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const OTHER_TOKEN = "0x2222222222222222222222222222222222222222" as `0x${string}`;
const PAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as `0x${string}`;
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;
const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const NETWORK = "eip155:84532" as Network;
const TX = `0x${"ab".repeat(32)}` as `0x${string}`;

function computeChannelId(config: ChannelConfig): `0x${string}` {
  return computeChannelIdForNetwork(config, NETWORK);
}

function buildChannelConfig(saltSuffix = "00"): ChannelConfig {
  const salt = `0x${"00".repeat(31)}${saltSuffix.padStart(2, "0")}` as `0x${string}`;
  return {
    payer: PAYER,
    payerAuthorizer: ZERO,
    receiver: RECEIVER,
    receiverAuthorizer: ZERO,
    token: TOKEN,
    withdrawDelay: 900,
    salt,
  };
}

function buildSession(overrides: Partial<Channel> = {}): Channel {
  const config = overrides.channelConfig ?? buildChannelConfig();
  const channelId = overrides.channelId ?? computeChannelId(config);
  return {
    channelId,
    channelConfig: config,
    chargedCumulativeAmount: "1000",
    signedMaxClaimable: "1000",
    signature: "0xdeadbeef",
    balance: "10000",
    totalClaimed: "0",
    withdrawRequestedAt: 0,
    refundNonce: 0,
    lastRequestTimestamp: Date.now(),
    ...overrides,
  };
}

type FakeFacilitator = FacilitatorClient & {
  settle: MockedFunction<FacilitatorClient["settle"]>;
};

function buildFacilitator(
  settleImpl: (payload: PaymentPayload, reqs: PaymentRequirements) => Promise<SettleResponse>,
): FakeFacilitator {
  return {
    verify: vi.fn<FacilitatorClient["verify"]>(async () => ({ isValid: true }) as VerifyResponse),
    settle: vi.fn<FacilitatorClient["settle"]>(settleImpl),
    getSupported: vi.fn<FacilitatorClient["getSupported"]>(
      async () => ({ kinds: [] }) as unknown as SupportedResponse,
    ),
  };
}

function successSettle(reqs: PaymentRequirements, amount = "3000"): SettleResponse {
  return { success: true, transaction: TX, network: reqs.network, amount };
}

function buildManager(opts?: {
  facilitator?: FakeFacilitator;
  readReceiverSettlement?: ReadReceiverSettlement;
  storage?: InMemoryChannelStorage;
  network?: Network;
}): {
  manager: BatchSettlementChannelManager;
  facilitator: FakeFacilitator;
  storage: InMemoryChannelStorage;
  scheme: BatchSettlementEvmScheme;
} {
  const storage = opts?.storage ?? new InMemoryChannelStorage();
  const scheme = new BatchSettlementEvmScheme(RECEIVER, { storage });
  const facilitator =
    opts?.facilitator ??
    buildFacilitator(async (payload, reqs) => {
      const amount = (payload.payload as { amount?: unknown }).amount;
      return successSettle(
        reqs,
        typeof amount === "string" && /^\d+$/.test(amount) ? amount : "3000",
      );
    });
  const manager = scheme.createChannelManager(facilitator, opts?.network ?? NETWORK, TOKEN, {
    readReceiverSettlement: opts?.readReceiverSettlement,
  });
  return { manager, facilitator, storage, scheme };
}

function statefulReader(state: { claimed: bigint; settled: bigint }): ReadReceiverSettlement {
  return async (scope: ReceiverSettlementScope): Promise<ReceiverSettlementSnapshot> => ({
    ...scope,
    totalClaimed: state.claimed,
    totalSettled: state.settled,
  });
}

describe("claimed-but-unsettled recovery", () => {
  it("does not settle when the scoped observation is zero", async () => {
    const { manager, facilitator } = buildManager({
      readReceiverSettlement: statefulReader({ claimed: 0n, settled: 0n }),
    });

    const result = await manager.claimAndSettle();

    expect(result.claims).toEqual([]);
    expect(result.settle).toBeUndefined();
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("settles an external claim for this payTo and token without a local channel", async () => {
    const state = { claimed: 3000n, settled: 0n };
    const reader = vi.fn(statefulReader(state));
    const facilitator = buildFacilitator(async (payload, reqs) => {
      expect((payload.payload as { receiver?: string }).receiver).toBe(RECEIVER);
      expect((payload.payload as { token?: string }).token).toBe(TOKEN);
      expect(reqs.network).toBe(NETWORK);
      expect(reqs.payTo).toBe(RECEIVER);
      state.settled = 3000n;
      return successSettle(reqs, "3000");
    });
    const { manager } = buildManager({ facilitator, readReceiverSettlement: reader });

    const result = await manager.claimAndSettle();

    expect(result.settle?.transaction).toBe(TX);
    expect(reader).toHaveBeenCalledWith({ network: NETWORK, receiver: RECEIVER, token: TOKEN });
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("rejects an observation that leaves this manager's scope before any settle", async () => {
    const reader: ReadReceiverSettlement = async scope => ({
      network: scope.network,
      receiver: OTHER_RECEIVER,
      token: scope.token,
      totalClaimed: 3000n,
      totalSettled: 0n,
    });
    const { manager, facilitator } = buildManager({ readReceiverSettlement: reader });

    await expect(manager.claimAndSettle()).rejects.toThrow(/left this manager/);
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("rejects a snapshot whose token is not this manager's token", async () => {
    const reader: ReadReceiverSettlement = async scope => ({
      ...scope,
      token: OTHER_TOKEN,
      totalClaimed: 3000n,
      totalSettled: 0n,
    });
    const { manager, facilitator } = buildManager({ readReceiverSettlement: reader });

    await expect(manager.stop({ flush: true })).rejects.toThrow(/left this manager/);
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("does not call settle again after the scoped total is fully settled", async () => {
    const state = { claimed: 3000n, settled: 0n };
    const facilitator = buildFacilitator(async (_payload, reqs) => {
      state.settled = 3000n;
      return successSettle(reqs, "3000");
    });
    const { manager } = buildManager({
      facilitator,
      readReceiverSettlement: statefulReader(state),
    });

    await manager.claimAndSettle();
    facilitator.settle.mockClear();
    const repeated = await manager.claimAndSettle();

    expect(repeated.settle).toBeUndefined();
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("keeps a failed settle retryable and then transfers once", async () => {
    const state = { claimed: 3000n, settled: 0n };
    let attempts = 0;
    const facilitator = buildFacilitator(async (_payload, reqs) => {
      attempts += 1;
      if (attempts === 1) {
        return {
          success: false,
          errorReason: "boom",
          errorMessage: "settle reverted",
          transaction: "",
          network: reqs.network,
        };
      }
      state.settled = 3000n;
      return successSettle(reqs, "3000");
    });
    const { manager } = buildManager({
      facilitator,
      readReceiverSettlement: statefulReader(state),
    });

    await expect(manager.claimAndSettle()).rejects.toThrow(/Settle failed/);
    const recovered = await manager.claimAndSettle();

    expect(recovered.settle?.transaction).toBe(TX);
    expect(attempts).toBe(2);
    expect(state.settled).toBe(3000n);
  });

  it("does not accept a success response that has no transaction hash", async () => {
    const state = { claimed: 3000n, settled: 0n };
    const facilitator = buildFacilitator(async (_payload, reqs) => ({
      success: true,
      transaction: "",
      amount: "3000",
      network: reqs.network,
    }));
    const { manager } = buildManager({
      facilitator,
      readReceiverSettlement: statefulReader(state),
    });

    await expect(manager.settle()).rejects.toThrow(/outcome unknown/);
    expect(state.settled).toBe(0n);
  });

  it("does not accept a mined transaction that transferred nothing", async () => {
    const state = { claimed: 3000n, settled: 0n };
    const facilitator = buildFacilitator(async (_payload, reqs) => successSettle(reqs, "0"));
    const { manager } = buildManager({
      facilitator,
      readReceiverSettlement: statefulReader(state),
    });

    await expect(manager.settle()).rejects.toThrow(/no Settled transfer/);
    expect(state.settled).toBe(0n);
  });

  it("does not accept a reported amount the chain did not record", async () => {
    const state = { claimed: 3000n, settled: 0n };
    const { manager } = buildManager({
      readReceiverSettlement: statefulReader(state),
    });

    await expect(manager.settle()).rejects.toThrow(/did not increase/);
    expect(state.settled).toBe(0n);
  });

  it("shares one in-flight settle across concurrent callers", async () => {
    const state = { claimed: 3000n, settled: 0n };
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let entered = false;
    const facilitator = buildFacilitator(async (_payload, reqs) => {
      entered = true;
      await gate;
      state.settled = 3000n;
      return successSettle(reqs, "3000");
    });
    const { manager } = buildManager({
      facilitator,
      readReceiverSettlement: statefulReader(state),
    });

    const first = manager.settle();
    await vi.waitUntil(() => entered);
    const second = manager.settle();
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a.transaction).toBe(TX);
    expect(b.transaction).toBe(TX);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("stops retrying when a later read shows the pair is already settled", async () => {
    const state = { claimed: 3000n, settled: 3000n };
    const facilitator = buildFacilitator(async (_payload, reqs) => ({
      success: false,
      errorReason: "invalid_batch_settlement_evm_nothing_to_settle",
      errorMessage: "nothing to settle for receiver and token",
      transaction: "",
      network: reqs.network,
    }));
    const { manager } = buildManager({
      facilitator,
      readReceiverSettlement: statefulReader(state),
    });

    const result = await manager.settle();
    expect(result.outcome).toBe("already-settled");
    expect(result.transaction).toBeUndefined();
    expect(facilitator.settle).not.toHaveBeenCalled();
    const followUp = await manager.claimAndSettle();

    expect(followUp.settle).toBeUndefined();
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("settles after an in-process refund that submitted claims, without a reader", async () => {
    const storage = new InMemoryChannelStorage();
    const session = buildSession({
      chargedCumulativeAmount: "3000",
      totalClaimed: "0",
      balance: "10000",
    });
    await storage.updateChannel(session.channelId, () => session);
    const { manager, facilitator } = buildManager({ storage });

    await manager.refund();
    facilitator.settle.mockClear();
    const flushed = await manager.claimAndSettle();

    expect(flushed.claims).toEqual([]);
    expect(flushed.settle?.transaction).toBe(TX);
    const payload = facilitator.settle.mock.calls[0][0].payload as { type: string };
    expect(payload.type).toBe("settle");
  });

  it("does not settle an in-process refund that submitted no claim", async () => {
    const storage = new InMemoryChannelStorage();
    const session = buildSession({
      chargedCumulativeAmount: "1000",
      totalClaimed: "1000",
      balance: "10000",
    });
    await storage.updateChannel(session.channelId, () => session);
    const { manager, facilitator } = buildManager({ storage });

    await manager.refund();
    facilitator.settle.mockClear();
    const flushed = await manager.claimAndSettle();

    expect(flushed.settle).toBeUndefined();
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("lets shouldSettle refuse a chain observation without calling settle", async () => {
    vi.useFakeTimers();
    try {
      const calls: SettleResult[] = [];
      const { manager, facilitator } = buildManager({
        readReceiverSettlement: statefulReader({ claimed: 3000n, settled: 0n }),
      });
      manager.start({
        settleIntervalSecs: 1,
        shouldSettle: () => false,
        onSettle: result => {
          calls.push(result);
        },
      });

      await vi.advanceTimersByTimeAsync(1100);
      await vi.runAllTicks();
      await manager.stop();

      expect(calls).toEqual([]);
      expect(facilitator.settle).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a reader failure from the settle job and does not send a transaction", async () => {
    vi.useFakeTimers();
    try {
      const errors: unknown[] = [];
      const { manager, facilitator } = buildManager({
        readReceiverSettlement: async () => {
          throw new Error("rpc down");
        },
      });
      manager.start({
        settleIntervalSecs: 1,
        onError: error => {
          errors.push(error);
        },
      });

      await vi.advanceTimersByTimeAsync(1100);
      await vi.runAllTicks();
      await manager.stop();

      expect(errors.map(error => (error as Error).message)).toContain("rpc down");
      expect(facilitator.settle).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes an externally claimed balance on stop", async () => {
    const state = { claimed: 3000n, settled: 0n };
    const facilitator = buildFacilitator(async (_payload, reqs) => {
      state.settled = 3000n;
      return successSettle(reqs, "3000");
    });
    const { manager } = buildManager({
      facilitator,
      readReceiverSettlement: statefulReader(state),
    });

    manager.start({ settleIntervalSecs: 3600 });
    await manager.stop({ flush: true });

    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    expect(state.settled).toBe(3000n);
  });

  it("accepts a checksum-normalized receiver and token for this pair", async () => {
    const state = { claimed: 3000n, settled: 0n };
    const facilitator = buildFacilitator(async (_payload, reqs) => {
      state.settled = 3000n;
      return successSettle(reqs, "3000");
    });
    const reader: ReadReceiverSettlement = async scope => ({
      network: scope.network,
      receiver: getAddress(scope.receiver),
      token: getAddress(scope.token).toLowerCase() as `0x${string}`,
      totalClaimed: state.claimed,
      totalSettled: state.settled,
    });
    const { manager } = buildManager({ facilitator, readReceiverSettlement: reader });

    const result = await manager.claimAndSettle();

    expect(result.settle?.transaction).toBe(TX);
    expect(state.settled).toBe(3000n);
  });

  it.each([
    "eip155:01",
    "eip155:",
    "eip155:0x1",
    "eip155:1e2",
    "eip155:+1",
    "eip155:9007199254740993",
  ])("does not settle when this manager network is %s", async network => {
    const reader = vi.fn(statefulReader({ claimed: 3000n, settled: 0n }));
    const { manager, facilitator } = buildManager({
      readReceiverSettlement: reader,
      network: network as Network,
    });

    await expect(manager.claimAndSettle()).rejects.toThrow(/eip155/);
    expect(reader).not.toHaveBeenCalled();
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("does not auto-settle a negative snapshot", async () => {
    vi.useFakeTimers();
    try {
      const errors: string[] = [];
      const reader = vi.fn<ReadReceiverSettlement>(async scope => ({
        ...scope,
        totalClaimed: -5n,
        totalSettled: -6n,
      }));
      const { manager, facilitator } = buildManager({ readReceiverSettlement: reader });
      manager.start({
        settleIntervalSecs: 1,
        onError: error => {
          errors.push(error instanceof Error ? error.message : String(error));
        },
      });

      await vi.advanceTimersByTimeAsync(1100);
      await vi.runAllTicks();
      await manager.stop();

      expect(errors.join("\n")).toMatch(/negative/);
      expect(facilitator.settle).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { totalClaimed: 9, totalSettled: 2 },
    { totalClaimed: "3000", totalSettled: "0" },
  ])("does not settle a non-bigint snapshot %j", async totals => {
    const reader: ReadReceiverSettlement = async scope =>
      ({
        ...scope,
        totalClaimed: totals.totalClaimed,
        totalSettled: totals.totalSettled,
      }) as unknown as ReceiverSettlementSnapshot;
    const { manager, facilitator } = buildManager({ readReceiverSettlement: reader });

    await expect(manager.claimAndSettle()).rejects.toThrow(/non-bigint/);
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("does not treat a different-network success as this manager's completion", async () => {
    const state = { claimed: 3000n, settled: 0n };
    const facilitator = buildFacilitator(async () => {
      state.settled = 3000n;
      return {
        success: true,
        transaction: TX,
        amount: "3000",
        network: "eip155:1" as Network,
      };
    });
    const { manager } = buildManager({
      facilitator,
      readReceiverSettlement: statefulReader(state),
    });

    await expect(manager.settle()).rejects.toThrow(/did not name this manager's network/);
    facilitator.settle.mockClear();
    await expect(manager.claimAndSettle()).rejects.toThrow(/unresolved/);
    expect(facilitator.settle).not.toHaveBeenCalled();
    expect(state.settled).toBe(3000n);
  });

  it("does not treat a missing facilitator network as this manager's completion", async () => {
    const state = { claimed: 3000n, settled: 0n };
    const facilitator = buildFacilitator(async (_payload, reqs) => {
      state.settled = 3000n;
      const response = successSettle(reqs, "3000");
      Reflect.deleteProperty(response, "network");
      return response;
    });
    const { manager } = buildManager({
      facilitator,
      readReceiverSettlement: statefulReader(state),
    });

    await expect(manager.settle()).rejects.toThrow(/did not name this manager's network/);
    facilitator.settle.mockClear();
    await expect(manager.claimAndSettle()).rejects.toThrow(/unresolved/);
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("keeps a foreign-network effect unresolved without issuing another settle", async () => {
    const state = { claimed: 3000n, settled: 0n };
    let attempts = 0;
    const facilitator = buildFacilitator(async (_payload, reqs) => {
      attempts += 1;
      if (attempts === 1) {
        return {
          success: true,
          transaction: TX,
          amount: "3000",
          network: "eip155:1" as Network,
        };
      }
      state.settled = 3000n;
      return successSettle(reqs, "3000");
    });
    const { manager } = buildManager({
      facilitator,
      readReceiverSettlement: statefulReader(state),
    });

    await expect(manager.settle()).rejects.toThrow(/did not name this manager's network/);
    await expect(manager.settle()).rejects.toThrow(/unresolved/);
    expect(attempts).toBe(1);
    expect(state.settled).toBe(0n);
    facilitator.settle.mockClear();
    await expect(manager.claimAndSettle()).rejects.toThrow(/unresolved/);
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("rejects a malformed foreign response even without a reader", async () => {
    const storage = new InMemoryChannelStorage();
    const session = buildSession({
      chargedCumulativeAmount: "3000",
      totalClaimed: "0",
      balance: "10000",
    });
    await storage.updateChannel(session.channelId, () => session);
    const facilitator = buildFacilitator(async () => ({
      success: true,
      transaction: "0xtx",
      amount: "3000",
      network: "eip155:1" as Network,
    }));
    const { manager } = buildManager({ storage, facilitator });

    await expect(manager.refund()).rejects.toThrow(/network/);
    facilitator.settle.mockClear();
    await expect(manager.claimAndSettle()).rejects.toThrow(/unresolved/);
    expect(facilitator.settle).not.toHaveBeenCalled();
  });
});

describe("readBatchSettlementReceiverState", () => {
  it.each([1, -1, Number.NaN, undefined, "31337"])(
    "refuses a foreign or malformed independently queried RPC chain %s",
    async connected => {
      const client = {
        chain: { id: foundry.id },
        getChainId: vi.fn(async () => connected as number),
        readContract: vi.fn(async () => [0n, 0n] as const),
      };
      await expect(
        readBatchSettlementReceiverState(client, {
          network: `eip155:${foundry.id}` as Network,
          receiver: RECEIVER,
          token: TOKEN,
        }),
      ).rejects.toThrow(/connected RPC chain/);
      expect(client.readContract).not.toHaveBeenCalled();
    },
  );

  it("refuses to infer RPC identity from configuration when chain discovery is absent", async () => {
    const client = {
      chain: { id: foundry.id },
      readContract: vi.fn(async () => [0n, 0n] as const),
    };
    await expect(
      readBatchSettlementReceiverState(
        client as unknown as Parameters<typeof readBatchSettlementReceiverState>[0],
        { network: `eip155:${foundry.id}` as Network, receiver: RECEIVER, token: TOKEN },
      ),
    ).rejects.toThrow(/independent RPC chain id/);
    expect(client.readContract).not.toHaveBeenCalled();
  });

  it("reads only the requested receiver and token on the matching chain", async () => {
    const client = {
      chain: { id: foundry.id },
      getChainId: async () => foundry.id,
      readContract: vi.fn(async () => [3000n, 0n] as const),
    };
    const scope = {
      network: `eip155:${foundry.id}` as Network,
      receiver: RECEIVER,
      token: TOKEN,
    };

    const snapshot = await readBatchSettlementReceiverState(client, scope);

    expect(snapshot.totalClaimed).toBe(3000n);
    expect(snapshot.totalSettled).toBe(0n);
    expect(snapshot.network).toBe(scope.network);
    expect(client.readContract.mock.calls[0][0].args).toEqual([
      getAddress(RECEIVER),
      getAddress(TOKEN),
    ]);
  });

  it("names an unknown chain when the public client has no chain id", async () => {
    const client = {
      getChainId: async () => 1,
      readContract: vi.fn(async () => [1n, 0n] as const),
    };

    await expect(
      readBatchSettlementReceiverState(client, {
        network: "eip155:1" as Network,
        receiver: RECEIVER,
        token: TOKEN,
      }),
    ).rejects.toThrow(/unknown/);
    expect(client.readContract).not.toHaveBeenCalled();
  });

  it("refuses a public client bound to another chain", async () => {
    const client = {
      chain: { id: 1 },
      getChainId: async () => 1,
      readContract: vi.fn(async () => [1n, 0n] as const),
    };

    await expect(
      readBatchSettlementReceiverState(client, {
        network: `eip155:${foundry.id}` as Network,
        receiver: RECEIVER,
        token: TOKEN,
      }),
    ).rejects.toThrow(/does not match/);
    expect(client.readContract).not.toHaveBeenCalled();
  });

  it("refuses an eip155 network whose chain id is not a non-negative integer", async () => {
    const client = {
      chain: { id: foundry.id },
      getChainId: async () => foundry.id,
      readContract: vi.fn(async () => [1n, 0n] as const),
    };

    await expect(
      readBatchSettlementReceiverState(client, {
        network: "eip155:abc" as Network,
        receiver: RECEIVER,
        token: TOKEN,
      }),
    ).rejects.toThrow(/eip155/);
    await expect(
      readBatchSettlementReceiverState(client, {
        network: "eip155:-1" as Network,
        receiver: RECEIVER,
        token: TOKEN,
      }),
    ).rejects.toThrow(/eip155/);
    expect(client.readContract).not.toHaveBeenCalled();
  });

  it("refuses a non-eip155 network", async () => {
    const client = {
      chain: { id: foundry.id },
      getChainId: async () => foundry.id,
      readContract: vi.fn(async () => [1n, 0n] as const),
    };

    await expect(
      readBatchSettlementReceiverState(client, {
        network: "solana:mainnet" as Network,
        receiver: RECEIVER,
        token: TOKEN,
      }),
    ).rejects.toThrow(/eip155/);
  });

  it("refuses a pair whose settled total exceeds claimed", async () => {
    const client = {
      chain: { id: foundry.id },
      getChainId: async () => foundry.id,
      readContract: vi.fn(async () => [1n, 2n] as const),
    };

    await expect(
      readBatchSettlementReceiverState(client, {
        network: `eip155:${foundry.id}` as Network,
        receiver: RECEIVER,
        token: TOKEN,
      }),
    ).rejects.toThrow(/exceeds claimed/);
  });

  it("reads canonical eip155:0 when the public client is that chain", async () => {
    const client = {
      chain: { id: 0 },
      getChainId: async () => 0,
      readContract: vi.fn(async () => [0n, 0n] as const),
    };

    const snapshot = await readBatchSettlementReceiverState(client, {
      network: "eip155:0" as Network,
      receiver: RECEIVER,
      token: TOKEN,
    });

    expect(snapshot.totalClaimed).toBe(0n);
    expect(snapshot.network).toBe("eip155:0");
    expect(client.readContract).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["eip155:1", 1],
    ["eip155:31337", 31337],
    ["eip155:84532", 84532],
    ["eip155:8453", 8453],
  ])("reads ordinary network %s", async (network, chainId) => {
    const client = {
      chain: { id: chainId },
      getChainId: async () => chainId,
      readContract: vi.fn(async () => [4n, 1n] as const),
    };

    const snapshot = await readBatchSettlementReceiverState(client, {
      network: network as Network,
      receiver: RECEIVER,
      token: TOKEN,
    });

    expect(snapshot.totalClaimed).toBe(4n);
    expect(snapshot.totalSettled).toBe(1n);
    expect(client.readContract).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["eip155:", 0],
    ["eip155:0x1", 1],
    ["eip155:1e2", 100],
    ["eip155:+1", 1],
    ["eip155:01", 1],
    ["eip155:00", 0],
    ["eip155: 31337", 31337],
    ["eip155:9007199254740993", Number("9007199254740993")],
  ])("refuses malformed eip155 reference %s before readContract", async (network, chainId) => {
    const client = {
      chain: { id: chainId },
      getChainId: async () => chainId,
      readContract: vi.fn(async () => [1n, 0n] as const),
    };

    await expect(
      readBatchSettlementReceiverState(client, {
        network: network as Network,
        receiver: RECEIVER,
        token: TOKEN,
      }),
    ).rejects.toThrow(/eip155/);
    expect(client.readContract).not.toHaveBeenCalled();
  });

  it("refuses negative totals from the contract read", async () => {
    const client = {
      chain: { id: foundry.id },
      getChainId: async () => foundry.id,
      readContract: vi.fn(async () => [-5n, -6n] as const),
    };

    await expect(
      readBatchSettlementReceiverState(client, {
        network: `eip155:${foundry.id}` as Network,
        receiver: RECEIVER,
        token: TOKEN,
      }),
    ).rejects.toThrow(/negative/);
  });

  it.each([
    [9, 2],
    ["3000", "0"],
  ])("refuses non-bigint contract totals %j", async (totalClaimed, totalSettled) => {
    const client = {
      chain: { id: foundry.id },
      getChainId: async () => foundry.id,
      readContract: vi.fn(
        async () => [totalClaimed, totalSettled] as unknown as readonly [bigint, bigint],
      ),
    };

    await expect(
      readBatchSettlementReceiverState(client, {
        network: `eip155:${foundry.id}` as Network,
        receiver: RECEIVER,
        token: TOKEN,
      }),
    ).rejects.toThrow(/non-bigint/);
  });
});

function deferred(): { promise: Promise<void>; release: () => void } {
  let settled = false;
  let release!: () => void;
  const promise = new Promise<void>(resolve => {
    release = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
  });
  return { promise, release };
}

function payloadAction(payload: PaymentPayload): string {
  return (payload.payload as { type?: string }).type ?? "";
}

describe("settlement lifecycle admission", () => {
  it("does not finish flush while an admitted claim is still unanswered", async () => {
    vi.useFakeTimers();
    const firstClaim = deferred();
    try {
      const storage = new InMemoryChannelStorage();
      const session = buildSession({
        chargedCumulativeAmount: "3000",
        totalClaimed: "0",
        balance: "10000",
      });
      await storage.updateChannel(session.channelId, () => session);
      const calls: string[] = [];
      const facilitator = buildFacilitator(async payload => {
        const action = payloadAction(payload);
        calls.push(action);
        if (action === "claim" && calls.filter(call => call === "claim").length === 1) {
          await firstClaim.promise;
        }
        if (action === "settle") return successSettle({ network: NETWORK } as PaymentRequirements);
        return { success: true, transaction: TX, network: NETWORK };
      });
      const { manager } = buildManager({ storage, facilitator });
      manager.start({ claimIntervalSecs: 1, settleIntervalSecs: 3600 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toEqual(["claim"]);

      const stopPromise = manager.stop({ flush: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.filter(call => call === "claim")).toHaveLength(1);

      firstClaim.release();
      await stopPromise;
      expect(calls.filter(call => call === "settle")).toEqual(["settle"]);
      facilitator.settle.mockClear();
      const followUp = await manager.claimAndSettle();
      expect(followUp.settle).toBeUndefined();
      expect(facilitator.settle).not.toHaveBeenCalled();
    } finally {
      firstClaim.release();
      vi.useRealTimers();
    }
  });

  it("awaits an admitted job on stop without flush, then can start again", async () => {
    vi.useFakeTimers();
    const firstClaim = deferred();
    try {
      const storage = new InMemoryChannelStorage();
      const session = buildSession({
        chargedCumulativeAmount: "3000",
        totalClaimed: "0",
        balance: "10000",
      });
      await storage.updateChannel(session.channelId, () => session);
      const facilitator = buildFacilitator(async payload => {
        if (payloadAction(payload) === "claim") await firstClaim.promise;
        if (payloadAction(payload) === "settle") {
          return successSettle({ network: NETWORK } as PaymentRequirements);
        }
        return { success: true, transaction: TX, network: NETWORK };
      });
      const { manager } = buildManager({ storage, facilitator });
      manager.start({ claimIntervalSecs: 1, settleIntervalSecs: 3600 });
      await vi.advanceTimersByTimeAsync(1000);

      let resolved = false;
      const stopping = manager.stop().then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(false);

      firstClaim.release();
      await stopping;
      const followUp = await manager.claimAndSettle();
      expect(followUp.settle?.transaction).toBe(TX);
      manager.start({ settleIntervalSecs: 3600 });
      await manager.stop();
    } finally {
      firstClaim.release();
      vi.useRealTimers();
    }
  });

  it("flushes only after a rejected admitted claim has finished", async () => {
    vi.useFakeTimers();
    const firstClaim = deferred();
    try {
      const storage = new InMemoryChannelStorage();
      const session = buildSession({
        chargedCumulativeAmount: "3000",
        totalClaimed: "0",
        balance: "10000",
      });
      await storage.updateChannel(session.channelId, () => session);
      let claimCalls = 0;
      let settleCalls = 0;
      const facilitator = buildFacilitator(async payload => {
        const action = payloadAction(payload);
        if (action === "claim") {
          claimCalls += 1;
          if (claimCalls === 1) {
            await firstClaim.promise;
            return {
              success: false,
              errorReason: "boom",
              errorMessage: "claim reverted",
              transaction: "",
              network: NETWORK,
            };
          }
          return { success: true, transaction: TX, network: NETWORK };
        }
        settleCalls += 1;
        return successSettle({ network: NETWORK } as PaymentRequirements);
      });
      const { manager } = buildManager({ storage, facilitator });
      manager.start({ claimIntervalSecs: 1, settleIntervalSecs: 3600 });
      await vi.advanceTimersByTimeAsync(1000);

      const stopping = manager.stop({ flush: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(claimCalls).toBe(1);

      firstClaim.release();
      await stopping;
      expect(claimCalls).toBe(2);
      expect(settleCalls).toBe(1);
    } finally {
      firstClaim.release();
      vi.useRealTimers();
    }
  });

  it("runs one flush when stop is called twice while a claim is admitted", async () => {
    vi.useFakeTimers();
    const firstClaim = deferred();
    try {
      const storage = new InMemoryChannelStorage();
      const session = buildSession({
        chargedCumulativeAmount: "3000",
        totalClaimed: "0",
        balance: "10000",
      });
      await storage.updateChannel(session.channelId, () => session);
      let claimCalls = 0;
      let settleCalls = 0;
      const facilitator = buildFacilitator(async payload => {
        const action = payloadAction(payload);
        if (action === "claim") {
          claimCalls += 1;
          if (claimCalls === 1) await firstClaim.promise;
          return { success: true, transaction: TX, network: NETWORK };
        }
        settleCalls += 1;
        return successSettle({ network: NETWORK } as PaymentRequirements);
      });
      const { manager } = buildManager({ storage, facilitator });
      manager.start({ claimIntervalSecs: 1, settleIntervalSecs: 3600 });
      await vi.advanceTimersByTimeAsync(1000);

      const firstStop = manager.stop({ flush: true });
      const secondStop = manager.stop({ flush: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(claimCalls).toBe(1);

      firstClaim.release();
      await Promise.all([firstStop, secondStop]);
      expect(settleCalls).toBe(1);
      expect(claimCalls).toBe(1);
    } finally {
      firstClaim.release();
      vi.useRealTimers();
    }
  });

  it("does not deadlock when a claim callback calls stop", async () => {
    vi.useFakeTimers();
    try {
      const storage = new InMemoryChannelStorage();
      const session = buildSession({
        chargedCumulativeAmount: "3000",
        totalClaimed: "0",
        balance: "10000",
      });
      await storage.updateChannel(session.channelId, () => session);
      let settleCalls = 0;
      const facilitator = buildFacilitator(async payload => {
        if (payloadAction(payload) === "settle") {
          settleCalls += 1;
          return successSettle({ network: NETWORK } as PaymentRequirements);
        }
        return { success: true, transaction: TX, network: NETWORK };
      });
      const { manager } = buildManager({ storage, facilitator });
      let callbackFinished = false;
      manager.start({
        claimIntervalSecs: 1,
        settleIntervalSecs: 3600,
        onClaim: () => {
          void manager.stop({ flush: true }).then(() => {
            callbackFinished = true;
          });
        },
      });
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitUntil(() => callbackFinished);
      expect(settleCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a claim that commits while a no-reader settle is in flight", async () => {
    const storage = new InMemoryChannelStorage();
    const session = buildSession({
      chargedCumulativeAmount: "1000",
      totalClaimed: "0",
      balance: "10000",
    });
    await storage.updateChannel(session.channelId, () => session);
    const gate = deferred();
    let settleEntered = false;
    const facilitator = buildFacilitator(async payload => {
      if (payloadAction(payload) === "settle") {
        settleEntered = true;
        await gate.promise;
        return successSettle({ network: NETWORK } as PaymentRequirements, "1000");
      }
      return { success: true, transaction: TX, network: NETWORK };
    });
    const { manager } = buildManager({ storage, facilitator });

    const settling = manager.settle();
    await vi.waitUntil(() => settleEntered);
    await manager.claim();
    gate.release();
    await settling;
    facilitator.settle.mockClear();
    const followUp = await manager.claimAndSettle();

    expect(followUp.settle?.transaction).toBe(TX);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("keeps a refund claim that commits while a no-reader settle is in flight", async () => {
    const storage = new InMemoryChannelStorage();
    const session = buildSession({
      chargedCumulativeAmount: "3000",
      totalClaimed: "0",
      balance: "10000",
    });
    await storage.updateChannel(session.channelId, () => session);
    const gate = deferred();
    let settleEntered = false;
    const facilitator = buildFacilitator(async payload => {
      if (payloadAction(payload) === "settle") {
        settleEntered = true;
        await gate.promise;
        return successSettle({ network: NETWORK } as PaymentRequirements, "3000");
      }
      const amount = (payload.payload as { amount?: unknown }).amount;
      return {
        success: true,
        transaction: TX,
        network: NETWORK,
        ...(typeof amount === "string" ? { amount } : {}),
      };
    });
    const { manager } = buildManager({ storage, facilitator });

    const settling = manager.settle();
    await vi.waitUntil(() => settleEntered);
    await manager.refund();
    expect(await storage.list()).toEqual([]);
    gate.release();
    await settling;
    facilitator.settle.mockClear();
    const followUp = await manager.claimAndSettle();

    expect(followUp.settle?.transaction).toBe(TX);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("settles a reader-visible claim that arrives during settle once, then the remainder once", async () => {
    const storage = new InMemoryChannelStorage();
    const session = buildSession({
      chargedCumulativeAmount: "3000",
      totalClaimed: "0",
      balance: "10000",
    });
    await storage.updateChannel(session.channelId, () => session);
    const state = { claimed: 3000n, settled: 0n };
    const gate = deferred();
    let settleEntered = false;
    const facilitator = buildFacilitator(async (payload, reqs) => {
      if (payloadAction(payload) === "settle") {
        settleEntered = true;
        await gate.promise;
        state.settled += 3000n;
        return successSettle(reqs, "3000");
      }
      state.claimed += 3000n;
      return { success: true, transaction: TX, network: reqs.network };
    });
    const { manager } = buildManager({
      storage,
      facilitator,
      readReceiverSettlement: statefulReader(state),
    });

    const settling = manager.settle();
    await vi.waitUntil(() => settleEntered);
    await manager.claim();
    gate.release();
    await settling;
    expect(facilitator.settle).toHaveBeenCalledTimes(2);
    const followUp = await manager.claimAndSettle();
    expect(followUp.settle?.transaction).toBe(TX);
    expect(facilitator.settle).toHaveBeenCalledTimes(3);
    facilitator.settle.mockClear();
    const again = await manager.claimAndSettle();
    expect(again.settle).toBeUndefined();
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("reports an already-equal scope without inventing a transfer", async () => {
    const state = { claimed: 3000n, settled: 3000n };
    const facilitator = buildFacilitator(async (_payload, reqs) => ({
      success: false,
      errorReason: "invalid_batch_settlement_evm_nothing_to_settle",
      errorMessage: "nothing to settle for receiver and token",
      transaction: "",
      network: reqs.network,
    }));
    const { manager } = buildManager({
      facilitator,
      readReceiverSettlement: statefulReader(state),
    });

    const result = await manager.settle();

    expect(result.outcome).toBe("already-settled");
    expect(result.transaction).toBeUndefined();
    expect(facilitator.settle).not.toHaveBeenCalled();
    const followUp = await manager.claimAndSettle();
    expect(followUp.settle).toBeUndefined();
  });

  it("reports a noop when another manager settles between the read and the response", async () => {
    const state = { claimed: 3000n, settled: 0n };
    const facilitator = buildFacilitator(async (_payload, reqs) => {
      state.settled = state.claimed;
      return {
        success: false,
        errorReason: "invalid_batch_settlement_evm_nothing_to_settle",
        errorMessage: "nothing to settle for receiver and token",
        transaction: "",
        network: reqs.network,
      };
    });
    const { manager } = buildManager({
      facilitator,
      readReceiverSettlement: statefulReader(state),
    });

    const result = await manager.settle();

    expect(result.outcome).toBe("already-settled");
    expect(result.transaction).toBeUndefined();
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    facilitator.settle.mockClear();
    const followUp = await manager.claimAndSettle();
    expect(followUp.settle).toBeUndefined();
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("keeps a nothing-to-settle failure when the fresh read is still pending", async () => {
    const state = { claimed: 3000n, settled: 0n };
    let attempts = 0;
    const facilitator = buildFacilitator(async (_payload, reqs) => {
      attempts += 1;
      if (attempts === 1) {
        return {
          success: false,
          errorReason: "invalid_batch_settlement_evm_nothing_to_settle",
          errorMessage: "nothing to settle for receiver and token",
          transaction: "",
          network: reqs.network,
        };
      }
      state.settled = 3000n;
      return successSettle(reqs, "3000");
    });
    const { manager } = buildManager({
      facilitator,
      readReceiverSettlement: statefulReader(state),
    });

    await expect(manager.settle()).rejects.toThrow(/nothing to settle/);
    const recovered = await manager.settle();
    expect(recovered.transaction).toBe(TX);
    expect(recovered.outcome).toBe("settled");
  });

  it("keeps a no-reader obligation when settle reports nothing to settle", async () => {
    const storage = new InMemoryChannelStorage();
    const session = buildSession({
      chargedCumulativeAmount: "1000",
      totalClaimed: "0",
      balance: "10000",
    });
    await storage.updateChannel(session.channelId, () => session);
    let settleAttempts = 0;
    const facilitator = buildFacilitator(async payload => {
      if (payloadAction(payload) === "settle") {
        settleAttempts += 1;
        return {
          success: false,
          errorReason: "invalid_batch_settlement_evm_nothing_to_settle",
          errorMessage: "nothing to settle for receiver and token",
          transaction: "",
          network: NETWORK,
        };
      }
      return { success: true, transaction: TX, network: NETWORK };
    });
    const { manager } = buildManager({ storage, facilitator });

    await manager.claim();
    await expect(manager.settle()).rejects.toThrow(/nothing to settle/);
    await expect(manager.claimAndSettle()).rejects.toThrow(/nothing to settle/);
    expect(settleAttempts).toBe(2);
  });

  it("keeps a nothing-to-settle failure when the fresh read leaves scope", async () => {
    let reads = 0;
    const reader: ReadReceiverSettlement = async scope => {
      reads += 1;
      if (reads === 1) {
        return { ...scope, totalClaimed: 3000n, totalSettled: 0n };
      }
      return {
        ...scope,
        receiver: OTHER_RECEIVER,
        totalClaimed: 0n,
        totalSettled: 0n,
      };
    };
    const { manager, facilitator } = buildManager({
      readReceiverSettlement: reader,
      facilitator: buildFacilitator(async (_payload, reqs) => ({
        success: false,
        errorReason: "invalid_batch_settlement_evm_nothing_to_settle",
        errorMessage: "nothing to settle for receiver and token",
        transaction: "",
        network: reqs.network,
      })),
    });

    await expect(manager.settle()).rejects.toThrow(/left this manager/);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("gives claim, refund, and settle hooks the chain observation rather than a stale hint", async () => {
    vi.useFakeTimers();
    try {
      const storage = new InMemoryChannelStorage();
      const session = buildSession({
        chargedCumulativeAmount: "1000",
        totalClaimed: "0",
        balance: "10000",
      });
      await storage.updateChannel(session.channelId, () => session);
      const state = { claimed: 0n, settled: 0n };
      const facilitator = buildFacilitator(async payload => {
        if (payloadAction(payload) === "claim") state.claimed = 0n;
        return { success: true, transaction: TX, network: NETWORK };
      });
      const { manager } = buildManager({
        storage,
        facilitator,
        readReceiverSettlement: statefulReader(state),
      });
      await manager.claim();
      const seen: boolean[] = [];
      const record = (_channels: Channel[], context: { pendingSettle: boolean }) => {
        seen.push(context.pendingSettle);
        return [];
      };
      manager.start({
        claimIntervalSecs: 1,
        refundIntervalSecs: 1,
        settleIntervalSecs: 1,
        selectClaimChannels: record,
        selectRefundChannels: record,
        shouldSettle: context => {
          seen.push(context.pendingSettle);
          return false;
        },
      });
      await vi.advanceTimersByTimeAsync(1000);

      expect(seen.length).toBeGreaterThanOrEqual(3);
      expect(seen.every(value => value === false)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not call policy hooks with a boolean when the scope read is invalid", async () => {
    vi.useFakeTimers();
    try {
      const errors: string[] = [];
      const selectClaimChannels = vi.fn(() => []);
      const selectRefundChannels = vi.fn(() => []);
      const shouldSettle = vi.fn(() => false);
      const { manager } = buildManager({
        readReceiverSettlement: async scope => ({
          ...scope,
          totalClaimed: -5n,
          totalSettled: -6n,
        }),
      });
      manager.start({
        claimIntervalSecs: 1,
        refundIntervalSecs: 1,
        settleIntervalSecs: 1,
        selectClaimChannels,
        selectRefundChannels,
        shouldSettle,
        onError: error => {
          errors.push(error instanceof Error ? error.message : String(error));
        },
      });
      await vi.advanceTimersByTimeAsync(1000);

      expect(selectClaimChannels).not.toHaveBeenCalled();
      expect(selectRefundChannels).not.toHaveBeenCalled();
      expect(shouldSettle).not.toHaveBeenCalled();
      expect(errors.join("\n")).toMatch(/negative/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("211204 receiving seams", () => {
  it.each(["eip155:1\n", "eip155:1\r", "eip155:1\u2028", "eip155:1\u2029"])(
    "rejects a trailing line terminator in the canonical network %j",
    async network => {
      const client = {
        chain: { id: 1 },
        getChainId: async () => 1,
        readContract: vi.fn(async () => [0n, 0n] as const),
      };
      await expect(
        readBatchSettlementReceiverState(client, {
          network: network as Network,
          receiver: RECEIVER,
          token: TOKEN,
        }),
      ).rejects.toThrow(/canonical/);
      expect(client.readContract).not.toHaveBeenCalled();
    },
  );

  it.each(["claim", "refund"] as const)(
    "stop waits for an admitted direct %s, including rejection",
    async action => {
      const gate = deferred();
      const entered = deferred();
      const facilitator = buildFacilitator(async () => {
        entered.release();
        await gate.promise;
        return {
          success: false,
          errorReason: "rejected_before_broadcast",
          transaction: "",
          network: NETWORK,
        };
      });
      const { manager, storage } = buildManager({ facilitator });
      const channel = buildSession();
      await storage.updateChannel(channel.channelId, () => channel);
      const work = manager[action]().catch(error => error);
      await entered.promise;
      let finished = false;
      const stopped = manager.stop().then(() => {
        finished = true;
      });
      await new Promise(resolve => setTimeout(resolve, 0));
      const finishedBeforeEffect = finished;
      gate.release();
      const failure = await work;
      await stopped;
      expect(failure).toBeInstanceOf(Error);
      expect(finishedBeforeEffect).toBe(false);
    },
  );

  it("retains a confirmed claim obligation when the local channel update fails", async () => {
    const { manager, storage, facilitator } = buildManager();
    const channel = buildSession();
    await storage.updateChannel(channel.channelId, () => channel);
    const update = vi
      .spyOn(storage, "updateChannel")
      .mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(manager.claim()).rejects.toThrow(/disk unavailable/);
    update.mockRestore();
    await manager.claimAndSettle({ selectClaimChannels: () => [] });
    expect(facilitator.settle.mock.calls.map(([payload]) => payloadAction(payload))).toEqual([
      "claim",
      "settle",
    ]);
  });

  it("does not report an equal snapshot as a noop while a new claim is unresolved", async () => {
    const gate = deferred();
    const entered = deferred();
    const facilitator = buildFacilitator(async payload => {
      if (payloadAction(payload) === "claim") {
        entered.release();
        await gate.promise;
      }
      return {
        success: false,
        errorReason: "settlement_pending",
        transaction: TX,
        network: NETWORK,
      };
    });
    const { manager, storage } = buildManager({
      facilitator,
      readReceiverSettlement: statefulReader({ claimed: 0n, settled: 0n }),
    });
    const channel = buildSession();
    await storage.updateChannel(channel.channelId, () => channel);
    const claiming = manager.claim().catch(error => error);
    await entered.promise;
    const settling = manager.settle();
    const observed = await settling.then(
      result => result,
      error => error,
    );
    gate.release();
    await claiming;
    expect(observed).toBeInstanceOf(Error);
    expect(String(observed)).toMatch(/unknown|unresolved|in flight/);
  });

  it.each(["eip155:1", undefined])(
    "does not turn a nothing-to-settle response on %s into a noop",
    async network => {
      const state = { claimed: 1000n, settled: 0n };
      const facilitator = buildFacilitator(async () => {
        state.settled = 1000n;
        return {
          success: false,
          errorReason: "invalid_batch_settlement_evm_nothing_to_settle",
          transaction: "",
          network,
        } as SettleResponse;
      });
      const { manager } = buildManager({
        facilitator,
        readReceiverSettlement: statefulReader(state),
      });
      await expect(manager.settle()).rejects.toThrow(/network|unknown/);
    },
  );

  it("does not resend a pending claim, sign again, or discard its reservation on stop/start", async () => {
    const facilitator = buildFacilitator(async () => ({
      success: false,
      errorReason: "settlement_pending",
      transaction: TX,
      network: NETWORK,
    }));
    const { manager, storage } = buildManager({ facilitator });
    const channel = buildSession();
    await storage.updateChannel(channel.channelId, () => channel);
    await expect(manager.claim()).rejects.toThrow();
    await manager.stop();
    manager.start();
    await expect(manager.claim()).rejects.toThrow(/unknown|unresolved/);
    await manager.stop();
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    expect((await storage.get(channel.channelId))?.totalClaimed).toBe("0");
    expect((await storage.get(channel.channelId))?.balance).toBe("10000");
  });

  it("rejects a malformed no-reader success and keeps the refund channel", async () => {
    const facilitator = buildFacilitator(async () => ({
      success: true,
      transaction: "0xtx",
      network: "eip155:1",
    }));
    const { manager, storage } = buildManager({ facilitator });
    const channel = buildSession();
    await storage.updateChannel(channel.channelId, () => channel);
    await expect(manager.refund()).rejects.toThrow(/unknown|network/);
    const kept = await storage.get(channel.channelId);
    expect(kept?.balance).toBe(channel.balance);
    expect(kept?.chargedCumulativeAmount).toBe(channel.chargedCumulativeAmount);
    expect(kept?.totalClaimed).toBe(channel.totalClaimed);
    expect(kept?.signature).toBe(channel.signature);
    expect(kept?.pendingRequest?.unresolved).toBe(true);
    await expect(manager.refund()).rejects.toThrow(/unknown|unresolved/);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });
});

describe("211204 scoped lifecycle consumers", () => {
  it("does not claim or refund foreign token, receiver, or chain rows in shared storage", async () => {
    const { manager, storage, facilitator } = buildManager();
    const foreignConfigs = [
      buildChannelConfig("01"),
      buildChannelConfig("02"),
      buildChannelConfig("03"),
    ];
    foreignConfigs[0].token = OTHER_TOKEN;
    foreignConfigs[1].receiver = OTHER_RECEIVER;
    for (const [index, config] of foreignConfigs.entries()) {
      const channel = buildSession({
        channelConfig: config,
        channelId: computeChannelIdForNetwork(config, index === 2 ? "eip155:1" : NETWORK),
      });
      await storage.updateChannel(channel.channelId, () => channel);
    }
    expect(await manager.claim()).toEqual([]);
    expect(await manager.refund()).toEqual([]);
    expect(facilitator.settle).not.toHaveBeenCalled();
    expect(await storage.list()).toHaveLength(3);
  });

  it.each(["claim", "settle", "refund", "error"] as const)(
    "a %s hook can stop and restart without duplicate effects",
    async action => {
      vi.useFakeTimers();
      try {
        const calls: string[] = [];
        const facilitator = buildFacilitator(async (payload, reqs) => {
          calls.push(payloadAction(payload));
          if (action === "error")
            return {
              success: false,
              errorReason: "rejected_before_broadcast",
              transaction: "",
              network: NETWORK,
            };
          const amount = (payload.payload as { amount?: unknown }).amount;
          return successSettle(
            reqs,
            typeof amount === "string" && /^\d+$/.test(amount) ? amount : "1000",
          );
        });
        const { manager, storage } = buildManager({ facilitator });
        const channel = buildSession();
        await storage.updateChannel(channel.channelId, () => channel);
        if (action === "settle") await manager.claim();
        let restarted = false;
        let callbackStop: Promise<void> | undefined;
        const hook = () => {
          callbackStop = manager.stop({ flush: action !== "error" }).then(() => {
            manager.start();
            restarted = true;
          });
        };
        manager.start({
          claimIntervalSecs: action === "claim" || action === "error" ? 1 : undefined,
          settleIntervalSecs: action === "settle" ? 1 : undefined,
          refundIntervalSecs: action === "refund" ? 1 : undefined,
          selectRefundChannels: channels => channels,
          onClaim: action === "claim" ? hook : undefined,
          onSettle: action === "settle" ? hook : undefined,
          onRefund: action === "refund" ? hook : undefined,
          onError: action === "error" ? hook : undefined,
        });
        await vi.advanceTimersByTimeAsync(1000);
        await vi.waitUntil(() => restarted);
        await callbackStop;
        await Promise.all([manager.stop(), manager.stop()]);
        expect(calls.filter(call => call === "claim")).toHaveLength(action === "refund" ? 0 : 1);
        expect(calls.filter(call => call === "settle")).toHaveLength(action === "error" ? 0 : 1);
        expect((await storage.get(channel.channelId))?.balance ?? "10000").toBe("10000");
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
