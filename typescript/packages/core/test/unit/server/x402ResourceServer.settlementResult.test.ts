import { describe, expect, it, vi } from "vitest";
import { x402ResourceServer } from "../../../src/server/x402ResourceServer";
import { Network } from "../../../src/types";
import {
  MockFacilitatorClient,
  MockSchemeNetworkServer,
  buildPaymentPayload,
  buildPaymentRequirements,
  buildSettleResponse,
  buildSupportedResponse,
} from "../../mocks";

const network = "test:network" as Network;
const HASH = `0x${"ab".repeat(32)}`;

function requirements() {
  return buildPaymentRequirements({ scheme: "test-scheme", network });
}

describe("settlement result acceptance", () => {
  it("leaves an ordinary scheme success in place when an observer throws", async () => {
    const facilitator = new MockFacilitatorClient(
      buildSupportedResponse({
        kinds: [{ x402Version: 2, scheme: "test-scheme", network }],
      }),
    );
    facilitator.setSettleResponse(buildSettleResponse({ transaction: HASH, network }));
    const observed: string[] = [];
    const scheme = new MockSchemeNetworkServer("test-scheme", undefined, {
      onAfterSettle: async () => {
        observed.push("observer");
        throw new Error("log sink failed");
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const server = new x402ResourceServer(facilitator).register(network, scheme);
    await server.initialize();
    const settled = await server.settlePayment(buildPaymentPayload(), requirements());
    warn.mockRestore();
    expect(settled.success).toBe(true);
    expect(settled.transaction).toBe(HASH);
    expect(observed).toEqual(["observer"]);
  });

  it("quarantines an opted-in unresolved result before observers and keeps the original hash", async () => {
    const facilitator = new MockFacilitatorClient(
      buildSupportedResponse({
        kinds: [{ x402Version: 2, scheme: "test-scheme", network }],
      }),
    );
    facilitator.setSettleResponse(
      buildSettleResponse({
        success: true,
        transaction: HASH,
        network,
        amount: "1",
        payer: "0xpayer",
      }),
    );
    const observed: string[] = [];
    const scheme = new MockSchemeNetworkServer("test-scheme", undefined, {
      onAfterSettle: async () => {
        observed.push("observer");
      },
    });
    scheme.acceptSettlementResult = async () => ({
      outcome: "unresolved",
      reason: "response amount is not the admitted refund amount",
      retry: { network, transaction: HASH, binding: "refund-1" },
    });
    const server = new x402ResourceServer(facilitator).register(network, scheme);
    await server.initialize();
    const settled = await server.settlePayment(buildPaymentPayload(), requirements());
    expect(settled.success).toBe(false);
    expect(settled.errorReason).toBe("settlement_unresolved");
    expect(settled.transaction).toBe(HASH);
    expect(settled.extra?.settlementOutcome).toBe("quarantined");
    expect(settled.extra?.retryIdentity).toMatchObject({
      network,
      transaction: HASH,
      binding: "refund-1",
    });
    expect(settled.extra?.facilitatorAssertion).toMatchObject({
      success: true,
      transaction: HASH,
      amount: "1",
    });
    expect(observed).toEqual([]);
    expect(facilitator.settleCalls).toHaveLength(1);
  });

  it("converts a thrown acceptance into quarantine instead of a logged success", async () => {
    const facilitator = new MockFacilitatorClient(
      buildSupportedResponse({
        kinds: [{ x402Version: 2, scheme: "test-scheme", network }],
      }),
    );
    facilitator.setSettleResponse(buildSettleResponse({ transaction: HASH, network }));
    const scheme = new MockSchemeNetworkServer("test-scheme");
    scheme.acceptSettlementResult = async () => {
      throw new Error("refund validation failed");
    };
    const server = new x402ResourceServer(facilitator).register(network, scheme);
    await server.initialize();
    const settled = await server.settlePayment(buildPaymentPayload(), requirements());
    expect(settled.success).toBe(false);
    expect(settled.errorReason).toBe("settlement_unresolved");
    expect(settled.errorMessage).toBe("refund validation failed");
    expect(settled.transaction).toBe(HASH);
  });

  it("quarantines a skipped settle result before afterSettle observers", async () => {
    const facilitator = new MockFacilitatorClient(
      buildSupportedResponse({
        kinds: [{ x402Version: 2, scheme: "test-scheme", network }],
      }),
    );
    const observed: string[] = [];
    const scheme = new MockSchemeNetworkServer("test-scheme", undefined, {
      onBeforeSettle: async () => ({
        skip: true,
        result: buildSettleResponse({ success: true, transaction: HASH, network, amount: "1" }),
      }),
      onAfterSettle: async () => {
        observed.push("observer");
      },
    });
    scheme.acceptSettlementResult = async () => ({
      outcome: "unresolved",
      reason: "skipped result was not the admitted effect",
      retry: { network, transaction: HASH },
    });
    const server = new x402ResourceServer(facilitator).register(network, scheme);
    await server.initialize();
    const settled = await server.settlePayment(buildPaymentPayload(), requirements());
    expect(settled.success).toBe(false);
    expect(settled.errorReason).toBe("settlement_unresolved");
    expect(settled.transaction).toBe(HASH);
    expect(observed).toEqual([]);
    expect(facilitator.settleCalls).toHaveLength(0);
  });
});
