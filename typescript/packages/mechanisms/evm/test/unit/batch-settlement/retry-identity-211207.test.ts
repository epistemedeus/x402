import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import { BatchSettlementEvmScheme } from "../../../src/batch-settlement/client/scheme";
import { InMemoryClientChannelStorage } from "../../../src/batch-settlement/client/storage";
import type { RefundAttempt } from "../../../src/batch-settlement/client/refund";
import { BatchSettlementChannelManager } from "../../../src/batch-settlement/server/channelManager";
import { BatchSettlementEvmScheme as ServerScheme } from "../../../src/batch-settlement/server/scheme";
import { InMemoryChannelStorage, type Channel } from "../../../src/batch-settlement/server/storage";
import { computeChannelId } from "../../../src/batch-settlement/utils";
import type { AuthorizerSigner, ChannelConfig } from "../../../src/batch-settlement/types";
import type { ClientEvmSigner } from "../../../src/signer";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import * as Errors from "../../../src/batch-settlement/errors";

const PAYER_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const RECEIVER = "0x9876543210987654321098765432109876543210";
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NETWORK = "eip155:84532";
const URL = "https://merchant.example/refund";
const TX_A = `0x${"ab".repeat(32)}`;
const TX_B = `0x${"cd".repeat(32)}`;

function requirements(): PaymentRequirements {
  return {
    scheme: "batch-settlement",
    network: NETWORK,
    amount: "1000",
    asset: ASSET,
    payTo: RECEIVER,
    maxTimeoutSeconds: 3600,
    extra: {
      name: "USDC",
      version: "2",
      withdrawDelay: 900,
      receiverAuthorizer: "0x1111111111111111111111111111111111111111",
    },
  };
}

function paymentSignature(init?: RequestInit): string | undefined {
  const headers = init?.headers;
  if (!headers || headers instanceof Headers || Array.isArray(headers)) return undefined;
  return headers["PAYMENT-SIGNATURE"] ?? headers["payment-signature"];
}

describe("211207 original refund retry identity", () => {
  it("keeps the first same-network hash when a later response names another transaction", async () => {
    const account = privateKeyToAccount(PAYER_PRIVATE_KEY);
    let signCount = 0;
    const signer: ClientEvmSigner = {
      address: account.address,
      signTypedData: async msg => {
        signCount += 1;
        return account.signTypedData({
          domain: msg.domain,
          types: msg.types,
          primaryType: msg.primaryType,
          message: msg.message,
        } as Parameters<typeof account.signTypedData>[0]);
      },
    };
    const storage = new InMemoryClientChannelStorage();
    const client = new BatchSettlementEvmScheme(signer, { storage });
    const reqs = requirements();
    const channelId = computeChannelId(client.buildChannelConfig(reqs), NETWORK);
    await storage.set(channelId.toLowerCase(), {
      chargedCumulativeAmount: "1000",
      balance: "10000",
      totalClaimed: "0",
    });

    const { encodePaymentRequiredHeader, encodePaymentResponseHeader } = await import(
      "@x402/core/http"
    );
    const probe = new Response(null, {
      status: 402,
      headers: {
        "PAYMENT-REQUIRED": encodePaymentRequiredHeader({
          x402Version: 2,
          accepts: [reqs],
        }),
      },
    });
    const channelState = {
      channelId,
      balance: "8000",
      chargedCumulativeAmount: "1000",
      totalClaimed: "0",
      refundNonce: "1",
    };
    const settle = (transaction: string, amount: string) =>
      new Response(null, {
        status: 200,
        headers: {
          "PAYMENT-RESPONSE": encodePaymentResponseHeader({
            success: true,
            transaction,
            network: NETWORK,
            payer: account.address,
            amount,
            extra: { channelState },
          } as SettleResponse),
        },
      });

    const signatures: string[] = [];
    let submissions = 0;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signature = paymentSignature(init);
      if (!signature) return probe.clone();
      submissions += 1;
      signatures.push(signature);
      if (submissions === 1) return settle(TX_A, "1");
      return settle(TX_B, "2000");
    }) as typeof fetch;

    const attempts = (client as unknown as { refundAttempts: Map<string, RefundAttempt> })
      .refundAttempts;
    let firstMessage = "";
    try {
      await client.refund(URL, { amount: "2000", fetch: fetchImpl });
      firstMessage = "accepted";
    } catch (error) {
      firstMessage = error instanceof Error ? error.message : String(error);
    }
    const afterFirst = attempts.get(channelId.toLowerCase());
    const balanceAfterFirst = (await storage.get(channelId.toLowerCase()))?.balance;
    const signCountAfterFirst = signCount;
    const submissionsAfterFirst = submissions;

    let secondMessage = "";
    try {
      const accepted = await client.refund(URL, { amount: "2000", fetch: fetchImpl });
      secondMessage = `accepted:${accepted.transaction}:${accepted.amount}`;
    } catch (error) {
      secondMessage = error instanceof Error ? error.message : String(error);
    }
    const afterSecond = attempts.get(channelId.toLowerCase());
    const witness = {
      firstMessage,
      balanceAfterFirst,
      signCountAfterFirst,
      submissionsAfterFirst,
      attemptAfterFirst: afterFirst
        ? {
            unknown: afterFirst.unknown,
            submitted: afterFirst.submitted,
            transaction: afterFirst.transaction,
            effectiveAmount: afterFirst.effectiveAmount,
            payloadAmount: (afterFirst.payload?.payload as { amount?: string } | undefined)?.amount,
            hasPayload: afterFirst.payload !== undefined,
          }
        : null,
      secondMessage,
      balanceAfterSecond: (await storage.get(channelId.toLowerCase()))?.balance,
      signCount,
      submissions,
      signaturesIdentical: signatures.length === 2 && signatures[0] === signatures[1],
      attemptAfterSecond: afterSecond
        ? {
            unknown: afterSecond.unknown,
            transaction: afterSecond.transaction,
            effectiveAmount: afterSecond.effectiveAmount,
            hasPayload: afterSecond.payload !== undefined,
          }
        : null,
    };
    writeFileSync("/tmp/evm-211207-prefix-witness.json", `${JSON.stringify(witness, null, 2)}\n`);

    expect(witness).toEqual({
      firstMessage: expect.stringMatching(/admitted refund amount/),
      balanceAfterFirst: "10000",
      signCountAfterFirst: 1,
      submissionsAfterFirst: 1,
      attemptAfterFirst: {
        unknown: true,
        submitted: true,
        transaction: TX_A,
        effectiveAmount: "2000",
        payloadAmount: "2000",
        hasPayload: true,
      },
      secondMessage: expect.stringMatching(/different original transaction/),
      balanceAfterSecond: "10000",
      signCount: 1,
      submissions: 2,
      signaturesIdentical: true,
      attemptAfterSecond: {
        unknown: true,
        transaction: TX_A,
        effectiveAmount: "2000",
        hasPayload: true,
      },
    });
  });
});

const SERVER_PAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as `0x${string}`;
const SERVER_RECEIVER = "0x9876543210987654321098765432109876543210" as `0x${string}`;
const SERVER_TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;
const TX_SERVER_B = `0x${"cd".repeat(32)}`;

function serverAuthorizer(): AuthorizerSigner {
  const account = privateKeyToAccount(PAYER_PRIVATE_KEY as `0x${string}`);
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

function serverConfig(): ChannelConfig {
  return {
    payer: SERVER_PAYER,
    payerAuthorizer: SERVER_PAYER,
    receiver: SERVER_RECEIVER,
    receiverAuthorizer: serverAuthorizer().address,
    token: SERVER_TOKEN,
    withdrawDelay: 900,
    salt: `0x${"00".repeat(32)}` as `0x${string}`,
  };
}

function serverChannel(overrides: Partial<Channel> = {}): Channel {
  const config = overrides.channelConfig ?? serverConfig();
  return {
    channelId: overrides.channelId ?? computeChannelId(config, NETWORK),
    channelConfig: config,
    chargedCumulativeAmount: "1000",
    signedMaxClaimable: "1000",
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

describe("211207 server and manager retry identity", () => {
  it("does not replace a manager refund hash or submit a second transaction", async () => {
    const storage = new InMemoryChannelStorage();
    const stored = serverChannel();
    await storage.updateChannel(stored.channelId, () => stored);
    const scheme = new ServerScheme(SERVER_RECEIVER, { storage });
    let phase: "first" | "second" = "first";
    let settles = 0;
    const facilitator = {
      verify: vi.fn(async () => ({ isValid: true, payer: SERVER_PAYER })),
      settle: vi.fn(async (_payload, reqs) => {
        settles += 1;
        return {
          success: true,
          transaction: phase === "first" ? TX_A : TX_SERVER_B,
          network: reqs.network,
          payer: SERVER_PAYER,
          amount: phase === "first" ? "1" : "9000",
        } as SettleResponse;
      }),
      getSupported: vi.fn(async () => ({ kinds: [] })),
    };
    const manager: BatchSettlementChannelManager = scheme.createChannelManager(
      facilitator as unknown as FacilitatorClient,
      NETWORK,
      SERVER_TOKEN,
    );

    let firstError = "";
    try {
      await manager.refund();
      firstError = "accepted";
    } catch (error) {
      firstError = error instanceof Error ? error.message : String(error);
    }
    expect(firstError).toMatch(/admitted refund amount/);
    phase = "second";
    const retained = scheme.readRetainedRefund(stored.channelId);
    let secondError = "";
    try {
      const accepted = await manager.refund();
      secondError = `accepted:${JSON.stringify(accepted)}`;
    } catch (error) {
      secondError = error instanceof Error ? error.message : String(error);
    }

    expect(settles).toBe(1);
    expect(secondError).toMatch(/admitted refund amount/);
    expect(retained?.transaction).toBe(TX_A);
    expect(retained?.unresolved).toBe(true);
    expect(scheme.readRetainedRefund(stored.channelId)?.transaction).toBe(TX_A);
    expect((await storage.get(stored.channelId))?.balance).toBe("10000");
  });

  it("does not publish a different hash for the same admitted server refund", async () => {
    const storage = new InMemoryChannelStorage();
    const signer = serverAuthorizer();
    let authorizerSigns = 0;
    const counting = {
      ...signer,
      signTypedData: async (msg: Parameters<AuthorizerSigner["signTypedData"]>[0]) => {
        authorizerSigns += 1;
        return signer.signTypedData(msg);
      },
    };
    const scheme = new ServerScheme(SERVER_RECEIVER, {
      storage,
      receiverAuthorizerSigner: counting,
    });
    const stored = serverChannel({
      chargedCumulativeAmount: "3000",
      signedMaxClaimable: "3000",
      channelConfig: {
        ...serverConfig(),
        receiverAuthorizer: counting.address,
      },
    });
    stored.channelId = computeChannelId(stored.channelConfig, NETWORK);
    await storage.updateChannel(stored.channelId, () => stored);
    let phase: "first" | "second" = "first";
    let settles = 0;
    const facilitator = {
      verify: vi.fn(async () => ({
        isValid: true,
        payer: SERVER_PAYER,
        extra: { balance: "10000", totalClaimed: "0", refundNonce: 0, withdrawRequestedAt: 0 },
      })),
      settle: vi.fn(async () => {
        settles += 1;
        const transaction = phase === "first" ? TX_A : TX_SERVER_B;
        const amount = phase === "first" ? "1" : "7000";
        return {
          success: true,
          transaction,
          network: NETWORK,
          payer: SERVER_PAYER,
          amount,
          extra: {
            channelState: {
              channelId: stored.channelId,
              balance: "3000",
              totalClaimed: "3000",
              refundNonce: "1",
              withdrawRequestedAt: 0,
            },
          },
        } as SettleResponse;
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
      accepted: {
        scheme: "batch-settlement",
        network: NETWORK,
        amount: "0",
        asset: SERVER_TOKEN,
        payTo: SERVER_RECEIVER,
        maxTimeoutSeconds: 60,
        extra: { name: "USDC", version: "2", receiverAuthorizer: counting.address },
      },
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
    const reqs = payload.accepted;
    const verified = await resource.verifyPayment(payload, reqs);
    expect(verified.isValid).toBe(true);
    const first = await resource.settlePayment(payload, reqs);
    phase = "second";
    const signsAfterFirst = authorizerSigns;
    const second = await resource.settlePayment(payload, reqs);

    expect(first.success).toBe(false);
    expect(first.transaction).toBe(TX_A);
    expect(second.success).toBe(false);
    expect(second.transaction).toBe(TX_A);
    expect(second.errorReason).toBe("settlement_unresolved");
    expect(settles).toBe(2);
    expect(authorizerSigns).toBe(signsAfterFirst);
    expect((await storage.get(stored.channelId))?.balance).toBe("10000");
    expect(scheme.readRetainedRefund(stored.channelId)?.transaction).toBe(TX_A);
    expect(scheme.readRetainedRefund(stored.channelId)?.unresolved).toBe(true);
  });
});

interface ScriptedRefund {
  transaction: string;
  amount?: string;
  network?: string;
  payer?: string;
  success?: boolean;
  errorReason?: string;
  channelId?: string;
  refundNonce?: string;
  includeChannel?: boolean;
}

interface RefundSnapshot {
  message: string;
  balance?: string;
  present: boolean;
  unknown?: boolean;
  transaction?: string;
  effectiveAmount?: string;
  hasPayload?: boolean;
  signCount: number;
  submissions: number;
  signaturesIdentical: boolean;
}

async function driveRefund(input: {
  amount?: string;
  balance?: string;
  charged?: string;
  omitBalance?: boolean;
  steps: ScriptedRefund[];
  beforePaid?: (index: number, attempt: RefundAttempt | undefined) => void;
}): Promise<RefundSnapshot[]> {
  const account = privateKeyToAccount(PAYER_PRIVATE_KEY as `0x${string}`);
  let signCount = 0;
  const signer: ClientEvmSigner = {
    address: account.address,
    signTypedData: async msg => {
      signCount += 1;
      return account.signTypedData({
        domain: msg.domain,
        types: msg.types,
        primaryType: msg.primaryType,
        message: msg.message,
      } as Parameters<typeof account.signTypedData>[0]);
    },
  };
  const storage = new InMemoryClientChannelStorage();
  const client = new BatchSettlementEvmScheme(signer, { storage });
  const reqs = requirements();
  const channelId = computeChannelId(client.buildChannelConfig(reqs), NETWORK);
  await storage.set(channelId.toLowerCase(), {
    chargedCumulativeAmount: input.charged ?? "1000",
    ...(input.omitBalance ? {} : { balance: input.balance ?? "10000" }),
    totalClaimed: "0",
  });
  const { encodePaymentRequiredHeader, encodePaymentResponseHeader } = await import(
    "@x402/core/http"
  );
  const probe = new Response(null, {
    status: 402,
    headers: {
      "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ x402Version: 2, accepts: [reqs] }),
    },
  });
  const attempts = (client as unknown as { refundAttempts: Map<string, RefundAttempt> })
    .refundAttempts;
  const signatures: string[] = [];
  let submissions = 0;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const signature = paymentSignature(init);
    if (!signature) return probe.clone();
    const step = input.steps[submissions];
    if (!step) throw new Error("unexpected extra refund submission");
    input.beforePaid?.(submissions, attempts.get(channelId.toLowerCase()));
    submissions += 1;
    signatures.push(signature);
    const includeChannel = step.includeChannel !== false;
    const body: SettleResponse = {
      success: step.success !== false,
      transaction: step.transaction,
      network: (step.network ?? NETWORK) as SettleResponse["network"],
      payer: step.payer ?? account.address,
      ...(step.amount !== undefined ? { amount: step.amount } : {}),
      ...(step.errorReason !== undefined ? { errorReason: step.errorReason } : {}),
      ...(includeChannel
        ? {
            extra: {
              channelState: {
                channelId: step.channelId ?? channelId,
                balance: "8000",
                chargedCumulativeAmount: input.charged ?? "1000",
                totalClaimed: "0",
                refundNonce: step.refundNonce ?? "1",
              },
            },
          }
        : {}),
    };
    return new Response(null, {
      status: 200,
      headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(body) },
    });
  }) as typeof fetch;

  const snapshots: RefundSnapshot[] = [];
  for (let index = 0; index < input.steps.length; index += 1) {
    let message = "";
    try {
      const accepted = await client.refund(URL, {
        ...(input.amount !== undefined ? { amount: input.amount } : {}),
        fetch: fetchImpl,
      });
      message = `accepted:${accepted.transaction}:${accepted.amount ?? ""}`;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    const attempt = attempts.get(channelId.toLowerCase());
    snapshots.push({
      message,
      balance: (await storage.get(channelId.toLowerCase()))?.balance,
      present: attempt !== undefined,
      unknown: attempt?.unknown,
      transaction: attempt?.transaction,
      effectiveAmount: attempt?.effectiveAmount,
      hasPayload: attempt?.payload !== undefined,
      signCount,
      submissions,
      signaturesIdentical: signatures.every(signature => signature === signatures[0]),
    });
  }
  return snapshots;
}

describe("211207 admitted refund responses", () => {
  it("applies a partial admitted amount and deletes the attempt", async () => {
    const [done] = await driveRefund({
      amount: "2000",
      steps: [{ transaction: TX_A, amount: "2000" }],
    });
    expect(done).toMatchObject({
      message: `accepted:${TX_A}:2000`,
      balance: "8000",
      present: false,
      signCount: 1,
      submissions: 1,
    });
  });

  it("applies a full remainder and removes the channel", async () => {
    const [done] = await driveRefund({
      steps: [{ transaction: TX_A, amount: "9000" }],
    });
    expect(done).toMatchObject({
      message: `accepted:${TX_A}:9000`,
      balance: undefined,
      present: false,
      signCount: 1,
    });
  });

  it("applies an unconstrained full refund without a local balance", async () => {
    const [done] = await driveRefund({
      omitBalance: true,
      steps: [{ transaction: TX_A, amount: "1", includeChannel: false }],
    });
    expect(done).toMatchObject({
      message: `accepted:${TX_A}:1`,
      balance: undefined,
      present: false,
      signCount: 1,
    });
  });

  it("rejects an unclamped amount, then accepts the same hash at the admitted remainder", async () => {
    const [rejected, accepted] = await driveRefund({
      amount: "50000",
      steps: [
        { transaction: TX_A, amount: "50000" },
        { transaction: TX_A, amount: "9000" },
      ],
    });
    expect(rejected).toMatchObject({
      message: expect.stringMatching(/admitted refund amount/),
      balance: "10000",
      present: true,
      transaction: TX_A,
      effectiveAmount: "9000",
      signCount: 1,
      submissions: 1,
    });
    expect(accepted).toMatchObject({
      message: `accepted:${TX_A}:9000`,
      balance: undefined,
      present: false,
      signCount: 1,
      submissions: 2,
      signaturesIdentical: true,
    });
  });

  it("keeps the original hash across a payer conflict and accepts only that hash", async () => {
    const [payer, other, same] = await driveRefund({
      amount: "2000",
      steps: [
        { transaction: TX_A, amount: "2000", payer: `0x${"11".repeat(20)}` },
        { transaction: TX_B, amount: "2000" },
        { transaction: TX_A, amount: "2000" },
      ],
    });
    expect(payer).toMatchObject({
      message: expect.stringMatching(/payer/),
      balance: "10000",
      transaction: TX_A,
      present: true,
      signCount: 1,
    });
    expect(other).toMatchObject({
      message: expect.stringMatching(/different original transaction/),
      balance: "10000",
      transaction: TX_A,
      signCount: 1,
      signaturesIdentical: true,
    });
    expect(same).toMatchObject({
      message: `accepted:${TX_A}:2000`,
      balance: "8000",
      present: false,
      signCount: 1,
      signaturesIdentical: true,
    });
  });

  it("keeps the original hash across a channel conflict", async () => {
    const [channel, other, same] = await driveRefund({
      amount: "2000",
      steps: [
        { transaction: TX_A, amount: "2000", channelId: `0x${"11".repeat(32)}` },
        { transaction: TX_B, amount: "2000" },
        { transaction: TX_A, amount: "2000" },
      ],
    });
    expect(channel).toMatchObject({
      message: expect.stringMatching(/channel/),
      balance: "10000",
      transaction: TX_A,
    });
    expect(other.message).toMatch(/different original transaction/);
    expect(other.transaction).toBe(TX_A);
    expect(other.balance).toBe("10000");
    expect(same).toMatchObject({
      message: `accepted:${TX_A}:2000`,
      balance: "8000",
      present: false,
      signCount: 1,
      signaturesIdentical: true,
    });
  });

  it("checks a frozen nonce without binding one from an untrusted response", async () => {
    const [open] = await driveRefund({
      amount: "2000",
      steps: [{ transaction: TX_A, amount: "2000", refundNonce: "99" }],
    });
    expect(open.message).toBe(`accepted:${TX_A}:2000`);

    const [wrongAmount, wrongNonce, otherHash, corrected] = await driveRefund({
      amount: "2000",
      beforePaid: (index, attempt) => {
        if (index >= 1 && attempt) attempt.nonce = "4";
      },
      steps: [
        { transaction: TX_A, amount: "1", refundNonce: "99" },
        { transaction: TX_A, amount: "2000", refundNonce: "9" },
        { transaction: TX_B, amount: "2000", refundNonce: "5" },
        { transaction: TX_A, amount: "2000", refundNonce: "5" },
      ],
    });
    expect(wrongAmount).toMatchObject({
      transaction: TX_A,
      balance: "10000",
      message: expect.stringMatching(/admitted refund amount/),
    });
    expect(wrongNonce).toMatchObject({
      message: expect.stringMatching(/nonce/),
      transaction: TX_A,
      balance: "10000",
      signCount: 1,
    });
    expect(otherHash).toMatchObject({
      message: expect.stringMatching(/different original transaction/),
      transaction: TX_A,
      balance: "10000",
    });
    expect(corrected).toMatchObject({
      message: `accepted:${TX_A}:2000`,
      balance: "8000",
      present: false,
      signCount: 1,
      signaturesIdentical: true,
    });
  });

  it("does not bind a positive malformed hash or foreign network", async () => {
    const [malformed, afterMalformed] = await driveRefund({
      amount: "2000",
      steps: [
        { transaction: "0x1234", amount: "2000", success: true, errorReason: "bad_settlement" },
        { transaction: TX_A, amount: "2000" },
      ],
    });
    expect(malformed).toMatchObject({
      present: true,
      transaction: undefined,
      balance: "10000",
      signCount: 1,
    });
    expect(afterMalformed).toMatchObject({
      message: `accepted:${TX_A}:2000`,
      balance: "8000",
      present: false,
      signCount: 1,
      signaturesIdentical: true,
    });

    const [foreign, afterForeign] = await driveRefund({
      amount: "2000",
      steps: [
        { transaction: TX_A, amount: "2000", network: "eip155:1", success: true },
        { transaction: TX_B, amount: "2000" },
      ],
    });
    expect(foreign).toMatchObject({
      present: true,
      transaction: undefined,
      balance: "10000",
    });
    expect(afterForeign).toMatchObject({
      message: `accepted:${TX_B}:2000`,
      balance: "8000",
      present: false,
      signCount: 1,
    });
  });

  it("ignores a repeated invalid hash and then accepts a valid same-network hash", async () => {
    const invalid = `0x${"zz".repeat(32)}`;
    const [first, second, third] = await driveRefund({
      amount: "2000",
      steps: [
        { transaction: invalid, amount: "2000" },
        { transaction: invalid, amount: "2000" },
        { transaction: TX_A, amount: "2000" },
      ],
    });
    expect(first).toMatchObject({ transaction: undefined, balance: "10000", present: true });
    expect(second).toMatchObject({ transaction: undefined, balance: "10000", present: true });
    expect(third).toMatchObject({
      message: `accepted:${TX_A}:2000`,
      balance: "8000",
      present: false,
      signCount: 1,
      signaturesIdentical: true,
    });
  });

  it("accepts a corrected response that repeats the original hash", async () => {
    const [rejected, accepted] = await driveRefund({
      amount: "2000",
      steps: [
        { transaction: TX_A, amount: "1" },
        { transaction: TX_A, amount: "2000" },
      ],
    });
    expect(rejected).toMatchObject({
      transaction: TX_A,
      effectiveAmount: "2000",
      balance: "10000",
      hasPayload: true,
      unknown: true,
    });
    expect(accepted).toMatchObject({
      message: `accepted:${TX_A}:2000`,
      balance: "8000",
      present: false,
      signCount: 1,
      submissions: 2,
      signaturesIdentical: true,
    });
  });

  it("releases a known refusal and a confirmed revert of the original hash", async () => {
    const [refused] = await driveRefund({
      amount: "2000",
      steps: [
        {
          transaction: "",
          success: false,
          errorReason: Errors.ErrRefundNoBalance,
          includeChannel: false,
        },
      ],
    });
    expect(refused).toMatchObject({ present: false, balance: "10000", signCount: 1 });

    const [reverted] = await driveRefund({
      amount: "2000",
      steps: [
        {
          transaction: TX_A,
          success: false,
          errorReason: Errors.ErrRefundTransactionFailed,
          includeChannel: false,
        },
      ],
    });
    expect(reverted).toMatchObject({ present: false, balance: "10000", signCount: 1 });

    const [retained, otherRevert, sameRevert] = await driveRefund({
      amount: "2000",
      steps: [
        { transaction: TX_A, amount: "1" },
        {
          transaction: TX_B,
          success: false,
          errorReason: Errors.ErrRefundTransactionFailed,
          includeChannel: false,
        },
        {
          transaction: TX_A,
          success: false,
          errorReason: Errors.ErrRefundTransactionFailed,
          includeChannel: false,
        },
      ],
    });
    expect(retained.transaction).toBe(TX_A);
    expect(otherRevert).toMatchObject({
      present: true,
      transaction: TX_A,
      balance: "10000",
      signCount: 1,
    });
    expect(sameRevert).toMatchObject({ present: false, balance: "10000", signCount: 1 });
  });

  it("keeps the first asserted spelling and settles one corrected response in the other hex case", async () => {
    const upper = `0x${"AB".repeat(32)}`;
    const [stored, accepted] = await driveRefund({
      amount: "2000",
      steps: [
        { transaction: upper, amount: "1" },
        { transaction: TX_A, amount: "2000" },
      ],
    });
    expect(stored).toMatchObject({
      transaction: upper,
      unknown: true,
      present: true,
      balance: "10000",
      signCount: 1,
      hasPayload: true,
      effectiveAmount: "2000",
    });
    expect(accepted).toMatchObject({
      message: `accepted:${TX_A}:2000`,
      balance: "8000",
      present: false,
      signCount: 1,
      submissions: 2,
      signaturesIdentical: true,
    });
  });

  it("releases a confirmed revert of the stored hash when only the hex case differs", async () => {
    const upper = `0x${"AB".repeat(32)}`;
    const [stored, otherCase] = await driveRefund({
      amount: "2000",
      steps: [
        { transaction: upper, amount: "1" },
        {
          transaction: TX_A,
          success: false,
          errorReason: Errors.ErrRefundTransactionFailed,
          includeChannel: false,
        },
      ],
    });
    expect(stored).toMatchObject({
      transaction: upper,
      unknown: true,
      present: true,
      balance: "10000",
      signCount: 1,
    });
    expect(upper.toLowerCase()).toBe(TX_A);
    expect(upper).not.toBe(TX_A);
    expect(otherCase).toMatchObject({
      present: false,
      balance: "10000",
      signCount: 1,
      submissions: 2,
      signaturesIdentical: true,
    });
  });
});
