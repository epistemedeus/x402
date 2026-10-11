import { describe, expect, it, vi } from "vitest";
import type { MockedFunction } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { x402ResourceServer } from "@x402/core/server";
import type {
  FacilitatorClient,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { BatchSettlementChannelManager } from "../../../src/batch-settlement/server/channelManager";
import { BatchSettlementEvmScheme as ServerScheme } from "../../../src/batch-settlement/server/scheme";
import { InMemoryChannelStorage, type Channel } from "../../../src/batch-settlement/server/storage";
import { BatchSettlementEvmScheme as ClientScheme } from "../../../src/batch-settlement/client/scheme";
import {
  buildChannelConfig as buildClientChannelConfig,
  type BatchSettlementClientDeps,
} from "../../../src/batch-settlement/client/channel";
import { createBatchSettlementClientHooks } from "../../../src/batch-settlement/client/hooks";
import { InMemoryClientChannelStorage } from "../../../src/batch-settlement/client/storage";
import { signVoucher } from "../../../src/batch-settlement/client/voucher";
import { computeChannelId as computeChannelIdForNetwork } from "../../../src/batch-settlement/utils";
import type { AuthorizerSigner, ChannelConfig } from "../../../src/batch-settlement/types";
import type { ClientEvmSigner } from "../../../src/signer";
import * as Errors from "../../../src/batch-settlement/errors";

vi.mock("../../../src/multicall", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../src/multicall")>();
  return { ...actual, multicall: vi.fn() };
});

import { multicall } from "../../../src/multicall";
import { BatchSettlementEvmScheme as FacilitatorScheme } from "../../../src/batch-settlement/facilitator/scheme";
import type { BatchSettlementEnrichedRefundPayload } from "../../../src/batch-settlement/types";
import type { FacilitatorEvmSigner } from "../../../src/signer";

const mockedMulticall = multicall as unknown as MockedFunction<typeof multicall>;
const PAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as `0x${string}`;
const RECEIVER = "0x9876543210987654321098765432109876543210" as `0x${string}`;
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;
const NETWORK = "eip155:84532";
const TX = `0x${"ab".repeat(32)}` as `0x${string}`;
const PAYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

function computeChannelId(config: ChannelConfig): `0x${string}` {
  return computeChannelIdForNetwork(config, NETWORK);
}

function authorizer(): AuthorizerSigner {
  const account = privateKeyToAccount(PAYER_KEY);
  return {
    address: account.address,
    signTypedData: msg =>
      account.signTypedData({
        domain: msg.domain,
        types: msg.types,
        primaryType: msg.primaryType,
        message: msg.message,
      } as Parameters<typeof account.signTypedData>[0]),
  };
}

function clientSigner(): ClientEvmSigner {
  const account = privateKeyToAccount(PAYER_KEY);
  return {
    address: account.address,
    signTypedData: msg =>
      account.signTypedData({
        domain: msg.domain,
        types: msg.types,
        primaryType: msg.primaryType,
        message: msg.message,
      } as Parameters<typeof account.signTypedData>[0]),
  };
}

function channelConfig(saltSuffix = "00"): ChannelConfig {
  return {
    payer: PAYER,
    payerAuthorizer: PAYER,
    receiver: RECEIVER,
    receiverAuthorizer: authorizer().address,
    token: TOKEN,
    withdrawDelay: 900,
    salt: `0x${"00".repeat(31)}${saltSuffix}` as `0x${string}`,
  };
}

function session(overrides: Partial<Channel> = {}): Channel {
  const config = overrides.channelConfig ?? channelConfig();
  return {
    channelId: overrides.channelId ?? computeChannelId(config),
    channelConfig: config,
    chargedCumulativeAmount: "3000",
    signedMaxClaimable: "3000",
    signature: "0xdeadbeef",
    balance: "10000",
    totalClaimed: "0",
    withdrawRequestedAt: 0,
    refundNonce: 0,
    onchainSyncedAt: Date.now(),
    lastRequestTimestamp: Date.now() - 60_000,
    ...overrides,
  };
}

function requirements(amount = "4000"): PaymentRequirements {
  return {
    scheme: "batch-settlement",
    network: NETWORK,
    amount,
    asset: TOKEN,
    payTo: RECEIVER,
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2", receiverAuthorizer: authorizer().address },
  };
}

function refundResponse(amount: string, extra: Record<string, unknown> = {}): SettleResponse {
  return {
    success: true,
    transaction: TX,
    network: NETWORK,
    amount,
    payer: PAYER,
    extra,
  };
}

async function attemptFreshCharge(
  scheme: ServerScheme,
  stored: Channel,
  amount = "4000",
): Promise<string> {
  const maxClaimable = (BigInt(stored.chargedCumulativeAmount) + BigInt(amount)).toString();
  const voucher = await signVoucher(
    clientSigner(),
    stored.channelId as `0x${string}`,
    maxClaimable,
    NETWORK,
  );
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted: requirements(amount),
    payload: {
      type: "voucher",
      channelConfig: stored.channelConfig,
      voucher,
    },
  };
  const reqs = requirements(amount);
  const before = (await scheme.schemeHooks.onBeforeVerify!({
    paymentPayload: payload,
    requirements: reqs,
  } as never)) as { abort?: boolean; skip?: boolean; result?: VerifyResponse } | void;
  if (!before || before.abort || !before.skip || !before.result?.isValid) {
    return (await scheme.getStorage().get(stored.channelId))?.chargedCumulativeAmount ?? "missing";
  }
  const after = (await scheme.schemeHooks.onAfterVerify!({
    paymentPayload: payload,
    requirements: reqs,
    result: before.result,
  } as never)) as { abort?: boolean } | void;
  if (after && "abort" in after && after.abort) {
    return (await scheme.getStorage().get(stored.channelId))?.chargedCumulativeAmount ?? "missing";
  }
  await scheme.schemeHooks.onBeforeSettle!({
    paymentPayload: payload,
    requirements: reqs,
  } as never);
  return (await scheme.getStorage().get(stored.channelId))?.chargedCumulativeAmount ?? "missing";
}

describe("EVM-1 shared channel admission", () => {
  it("blocks a fresh-cache voucher while a manager refund owns the channel", async () => {
    const storage = new InMemoryChannelStorage();
    const signer = authorizer();
    const scheme = new ServerScheme(RECEIVER, { storage, receiverAuthorizerSigner: signer });
    let release: (response: SettleResponse) => void = () => {};
    const facilitator = {
      verify: vi.fn(),
      settle: vi.fn(
        () =>
          new Promise<SettleResponse>(resolve => {
            release = resolve;
          }),
      ),
      getSupported: vi.fn(),
    } as unknown as FacilitatorClient & { settle: MockedFunction<FacilitatorClient["settle"]> };
    const manager = new BatchSettlementChannelManager({
      scheme,
      facilitator,
      receiver: RECEIVER,
      token: TOKEN,
      network: NETWORK,
    });
    const stored = session();
    await storage.updateChannel(stored.channelId, () => stored);

    const flight = manager.refund([stored.channelId]);
    await vi.waitUntil(() => facilitator.settle.mock.calls.length === 1);
    expect(await attemptFreshCharge(scheme, stored, "4000")).toBe("3000");
    expect((await storage.get(stored.channelId))?.balance).toBe("10000");
    release(refundResponse("7000"));
    await expect(flight).resolves.toEqual([{ channel: stored.channelId, transaction: TX }]);
    expect(await storage.get(stored.channelId)).toBeUndefined();
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("keeps an unknown refund past the pending TTL and still refuses a voucher", async () => {
    const storage = new InMemoryChannelStorage();
    const scheme = new ServerScheme(RECEIVER, {
      storage,
      receiverAuthorizerSigner: authorizer(),
    });
    const facilitator = {
      verify: vi.fn(),
      settle: vi.fn(async () => refundResponse("1")),
      getSupported: vi.fn(),
    } as unknown as FacilitatorClient;
    const manager = new BatchSettlementChannelManager({
      scheme,
      facilitator,
      receiver: RECEIVER,
      token: TOKEN,
      network: NETWORK,
    });
    const stored = session();
    await storage.updateChannel(stored.channelId, () => stored);
    await expect(manager.refund()).rejects.toThrow(/unknown|admitted/);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
      expect(await attemptFreshCharge(scheme, stored, "4000")).toBe("3000");
    } finally {
      vi.useRealTimers();
    }
    expect((await storage.get(stored.channelId))?.chargedCumulativeAmount).toBe("3000");
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("does not charge a service when refund storage reconciliation fails", async () => {
    const storage = new InMemoryChannelStorage();
    const realUpdate = storage.updateChannel.bind(storage);
    storage.updateChannel = async (channelId, update) =>
      realUpdate(channelId, current => {
        const next = update(current);
        if (current && next === undefined) throw new Error("storage failed");
        return next;
      });
    const scheme = new ServerScheme(RECEIVER, {
      storage,
      receiverAuthorizerSigner: authorizer(),
    });
    const facilitator = {
      verify: vi.fn(),
      settle: vi.fn(async () => refundResponse("7000")),
      getSupported: vi.fn(),
    } as unknown as FacilitatorClient & { settle: MockedFunction<FacilitatorClient["settle"]> };
    const manager = new BatchSettlementChannelManager({
      scheme,
      facilitator,
      receiver: RECEIVER,
      token: TOKEN,
      network: NETWORK,
    });
    const stored = session();
    await storage.updateChannel(stored.channelId, () => stored);
    await expect(manager.refund()).rejects.toThrow(/storage failed|unknown|reconcile/);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    expect(await attemptFreshCharge(scheme, stored, "4000")).toBe("3000");
  });

  it("refuses a reentrant voucher from the refund callback before any second broadcast", async () => {
    const storage = new InMemoryChannelStorage();
    const scheme = new ServerScheme(RECEIVER, {
      storage,
      receiverAuthorizerSigner: authorizer(),
    });
    const stored = session();
    await storage.updateChannel(stored.channelId, () => stored);
    const facilitator = {
      verify: vi.fn(),
      settle: vi.fn(async () => {
        expect(await attemptFreshCharge(scheme, stored, "4000")).toBe("3000");
        return refundResponse("7000");
      }),
      getSupported: vi.fn(),
    } as unknown as FacilitatorClient & { settle: MockedFunction<FacilitatorClient["settle"]> };
    const manager = new BatchSettlementChannelManager({
      scheme,
      facilitator,
      receiver: RECEIVER,
      token: TOKEN,
      network: NETWORK,
    });
    await expect(manager.refund()).resolves.toEqual([
      { channel: stored.channelId, transaction: TX },
    ]);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    expect(await storage.get(stored.channelId)).toBeUndefined();
  });
});

describe("EVM-2 admitted effective refund amount", () => {
  function deps(storage: InMemoryClientChannelStorage): BatchSettlementClientDeps {
    return {
      signer: clientSigner(),
      storage,
      salt: `0x${"00".repeat(32)}` as `0x${string}`,
    };
  }

  it("does not consume a positive amount other than the admitted effective amount", async () => {
    const storage = new InMemoryClientChannelStorage();
    const hooks = createBatchSettlementClientHooks(deps(storage));
    const reqs = requirements("0");
    const config = buildClientChannelConfig(deps(storage), reqs);
    const channelId = computeChannelId(config);
    const previous = { chargedCumulativeAmount: "1000", balance: "10000", totalClaimed: "0" };
    await storage.set(channelId.toLowerCase(), previous);
    await expect(
      hooks.onPaymentResponse!({
        paymentPayload: {
          x402Version: 2,
          accepted: reqs,
          payload: {
            type: "refund",
            channelConfig: config,
            voucher: { channelId, maxClaimableAmount: "1000", signature: "0xdead" },
            amount: "2000",
          },
        },
        requirements: reqs,
        settleResponse: refundResponse("1", {
          channelState: { channelId, balance: "9999", refundNonce: "1" },
        }),
      }),
    ).rejects.toThrow(/unknown/);
    expect(await storage.get(channelId.toLowerCase())).toEqual(previous);
  });

  it("accepts the clamped effective amount and rejects a tampered full-refund receipt", async () => {
    const storage = new InMemoryClientChannelStorage();
    const hooks = createBatchSettlementClientHooks(deps(storage));
    const reqs = requirements("0");
    const config = buildClientChannelConfig(deps(storage), reqs);
    const channelId = computeChannelId(config);
    const previous = { chargedCumulativeAmount: "1000", balance: "10000" };
    await storage.set(channelId.toLowerCase(), previous);
    await expect(
      hooks.onPaymentResponse!({
        paymentPayload: {
          x402Version: 2,
          accepted: reqs,
          payload: {
            type: "refund",
            channelConfig: config,
            voucher: { channelId, maxClaimableAmount: "1000", signature: "0xdead" },
          },
        },
        requirements: reqs,
        settleResponse: refundResponse("1", { channelState: { channelId, refundNonce: "1" } }),
      }),
    ).rejects.toThrow(/unknown/);
    expect(await storage.get(channelId.toLowerCase())).toEqual(previous);

    await hooks.onPaymentResponse!({
      paymentPayload: {
        x402Version: 2,
        accepted: reqs,
        payload: {
          type: "refund",
          channelConfig: config,
          voucher: { channelId, maxClaimableAmount: "1000", signature: "0xdead" },
          amount: "20000",
        },
      },
      requirements: reqs,
      settleResponse: refundResponse("9000", {
        channelState: { channelId, balance: "1000", refundNonce: "1" },
      }),
    });
    expect(await storage.get(channelId.toLowerCase())).toBeUndefined();
  });

  it("keeps a conflicting payer or channel reserved and does not sign again", async () => {
    const storage = new InMemoryClientChannelStorage();
    const client = new ClientScheme(clientSigner(), { storage });
    const reqs = requirements("0");
    const config = buildClientChannelConfig(deps(storage), reqs);
    const channelId = computeChannelId(config);
    await storage.set(channelId.toLowerCase(), {
      chargedCumulativeAmount: "1000",
      balance: "10000",
    });
    const signs: string[] = [];
    const signer = clientSigner();
    const wrapped = {
      ...signer,
      signTypedData: async (msg: Parameters<ClientEvmSigner["signTypedData"]>[0]) => {
        const signature = await signer.signTypedData(msg);
        signs.push(signature);
        return signature;
      },
    };
    const paying = new ClientScheme(wrapped, { storage });
    let submits = 0;
    const headerFor = async (body: SettleResponse) => {
      const { encodePaymentResponseHeader, encodePaymentRequiredHeader } = await import(
        "@x402/core/http"
      );
      return {
        probe: new Response(null, {
          status: 402,
          headers: {
            "PAYMENT-REQUIRED": encodePaymentRequiredHeader({
              x402Version: 2,
              accepts: [
                {
                  ...reqs,
                  extra: {
                    ...reqs.extra,
                    receiverAuthorizer: authorizer().address,
                  },
                },
              ],
            } as never),
          },
        }),
        settle: () => {
          submits += 1;
          return new Response(null, {
            status: 200,
            headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(body) },
          });
        },
      };
    };
    const hostile = await headerFor(
      refundResponse("2000", {
        channelState: {
          channelId: `0x${"11".repeat(32)}`,
          balance: "8000",
          refundNonce: "1",
        },
      }),
    );
    const fetchImpl = vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      const headers = init?.headers;
      const paid = headers?.["PAYMENT-SIGNATURE"] ?? headers?.["payment-signature"];
      if (!paid) return hostile.probe;
      return hostile.settle();
    });
    await expect(
      paying.refund("https://merchant.example/refund", {
        amount: "2000",
        fetch: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/unknown/);
    expect(submits).toBe(1);
    const signedOnce = signs.length;
    await expect(
      paying.refund("https://merchant.example/refund", {
        amount: "2000",
        fetch: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/unknown|unresolved/);
    expect(signs.length).toBe(signedOnce);
    expect((await storage.get(channelId.toLowerCase()))?.balance).toBe("10000");
    expect(client).toBeDefined();
  });
});

describe("EVM-3 channel-scoped refund result", () => {
  const FACILITATOR = "0xFAC11174700123456789012345678901234aBCDe" as `0x${string}`;

  function signer(): FacilitatorEvmSigner {
    return {
      getAddresses: () => [FACILITATOR],
      readContract: vi.fn().mockResolvedValue(undefined),
      verifyTypedData: vi.fn().mockResolvedValue(true),
      writeContract: vi.fn().mockResolvedValue(TX),
      sendTransaction: vi.fn(),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" }),
      getCode: vi.fn().mockResolvedValue("0x6080604052"),
    };
  }

  function state(balance = 10000n, claimed = 0n) {
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [balance, claimed] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ] as never);
  }

  function payload(
    config: ChannelConfig,
    claims: BatchSettlementEnrichedRefundPayload["claims"],
    amount = "9000",
  ): BatchSettlementEnrichedRefundPayload {
    return {
      type: "refund",
      channelConfig: config,
      voucher: {
        channelId: computeChannelId(config),
        maxClaimableAmount: "0",
        signature: "0xdead",
      },
      amount,
      refundNonce: "0",
      refundAuthorizerSignature: "0xserversig" as `0x${string}`,
      claimAuthorizerSignature: "0xclaimsig" as `0x${string}`,
      claims,
    };
  }

  function claim(config: ChannelConfig, totalClaimed: string) {
    return {
      voucher: { channel: config, maxClaimableAmount: totalClaimed },
      signature: "0xcafe" as `0x${string}`,
      totalClaimed,
    };
  }

  it.each([
    { label: "B claim 10000", other: "10000", expectedAmount: "9000", expectedClaimed: "0" },
    { label: "B claim 5000", other: "5000", expectedAmount: "9000", expectedClaimed: "0" },
    { label: "B claim 0", other: "0", expectedAmount: "9000", expectedClaimed: "0" },
  ])(
    "ignores a trailing cross-channel claim ($label)",
    async ({ other, expectedAmount, expectedClaimed }) => {
      state();
      const evm = signer();
      const scheme = new FacilitatorScheme(evm);
      const config = channelConfig("aa");
      const otherConfig = channelConfig("bb");
      const result = await scheme.settle(
        {
          x402Version: 2,
          accepted: requirements(),
          payload: payload(config, [claim(otherConfig, other)]),
        } as PaymentPayload,
        requirements(),
      );
      expect(result.success).toBe(true);
      expect(result.amount).toBe(expectedAmount);
      expect(result.extra?.channelState).toMatchObject({
        channelId: computeChannelId(config),
        totalClaimed: expectedClaimed,
        balance: (10000n - BigInt(expectedAmount)).toString(),
      });
    },
  );

  it("uses the same channel scope when claims are reordered", async () => {
    const config = channelConfig("aa");
    const otherConfig = channelConfig("bb");
    const orders = [
      [claim(otherConfig, "10000"), claim(config, "2000")],
      [claim(config, "2000"), claim(otherConfig, "10000")],
    ];
    for (const claims of orders) {
      state();
      const evm = signer();
      const scheme = new FacilitatorScheme(evm);
      const result = await scheme.settle(
        {
          x402Version: 2,
          accepted: requirements(),
          payload: payload(config, claims),
        } as PaymentPayload,
        requirements(),
      );
      expect(result.amount).toBe("8000");
      expect(result.extra?.channelState).toMatchObject({
        totalClaimed: "2000",
        balance: "2000",
      });
    }
  });

  it("does not report a mutated claim batch after the signed request was frozen", async () => {
    state();
    const evm = signer();
    const config = channelConfig("aa");
    const otherConfig = channelConfig("bb");
    const body = payload(config, [claim(config, "0")]);
    evm.writeContract = vi.fn(async () => {
      body.claims.splice(0, body.claims.length, claim(otherConfig, "10000"));
      return TX;
    });
    const scheme = new FacilitatorScheme(evm);
    const result = await scheme.settle(
      { x402Version: 2, accepted: requirements(), payload: body } as PaymentPayload,
      requirements(),
    );
    expect(result.success).toBe(true);
    expect(evm.writeContract).toHaveBeenCalled();
    expect(result.amount).toBe("9000");
    expect(result.extra?.channelState).toMatchObject({ totalClaimed: "0", balance: "1000" });
    expect(body.claims[0]?.totalClaimed).toBe("10000");
  });
});

describe("EVM-4 settlement result acceptance", () => {
  it("quarantines a positive foreign refund assertion instead of returning success", async () => {
    const storage = new InMemoryChannelStorage();
    const signer = authorizer();
    const scheme = new ServerScheme(RECEIVER, { storage, receiverAuthorizerSigner: signer });
    const stored = session({ chargedCumulativeAmount: "3000", balance: "10000" });
    await storage.updateChannel(stored.channelId, () => stored);
    let settles = 0;
    const facilitator = {
      verify: vi.fn(async () => ({
        isValid: true,
        payer: PAYER,
        extra: { balance: "10000", totalClaimed: "0", refundNonce: 0, withdrawRequestedAt: 0 },
      })),
      settle: vi.fn(async () => {
        settles += 1;
        return refundResponse("1", {
          channelState: {
            channelId: stored.channelId,
            balance: "3000",
            totalClaimed: "3000",
            refundNonce: "1",
            withdrawRequestedAt: 0,
          },
        });
      }),
      getSupported: vi.fn(async () => ({
        kinds: [{ x402Version: 2, scheme: "batch-settlement", network: NETWORK }],
        extensions: [],
        signers: {},
      })),
    } as unknown as FacilitatorClient;
    const resource = new x402ResourceServer(facilitator);
    resource.register(NETWORK, scheme);
    const payload: PaymentPayload = {
      x402Version: 2,
      accepted: requirements("0"),
      payload: {
        type: "refund",
        channelConfig: stored.channelConfig,
        voucher: {
          channelId: stored.channelId,
          maxClaimableAmount: "3000",
          signature: "0xdeadbeef",
        },
      },
    };
    const reqs = requirements("0");
    reqs.amount = "0";
    const verified = await resource.verifyPayment(payload, reqs);
    expect(verified.isValid).toBe(true);
    const observers: string[] = [];
    resource.onAfterSettle(async () => {
      observers.push("observer");
    });
    const settled = await resource.settlePayment(payload, reqs);
    expect(settled.success).toBe(false);
    expect(settled.errorReason).toBe("settlement_unresolved");
    expect(settled.transaction).toBe(TX);
    expect(settled.extra?.settlementOutcome).toBe("quarantined");
    expect(observers).toEqual([]);
    expect(settles).toBe(1);
    expect((await storage.get(stored.channelId))?.balance).toBe("10000");
    expect(scheme.readRetainedRefund(stored.channelId)?.unresolved).toBe(true);
    expect(Errors.ErrChannelBusy).toContain("channel_busy");
  });
});
