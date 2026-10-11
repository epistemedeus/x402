import assert from "node:assert/strict";
import {
  BatchSettlementEvmScheme,
  readBatchSettlementReceiverState,
  type SettleResult,
} from "@x402/evm/batch-settlement/server";

// Consume the actual SDK method rather than declaring another settlement API.
type ReceiverSettlementAPI = ReturnType<BatchSettlementEvmScheme["createChannelManager"]>;
const payTo = "0x00000000000000000000000000000000000000cc";
const token = "0x00000000000000000000000000000000000000aa";
const network = "eip155:31337";
let calls = 0;
const facilitator = {
  verify: async () => ({ isValid: true }),
  settle: async () => {
    calls += 1;
    throw new Error("equal receiver must not call facilitator");
  },
  getSupported: async () => ({ kinds: [], extensions: [], signers: {} }),
};
const api: ReceiverSettlementAPI = new BatchSettlementEvmScheme(payTo).createChannelManager(
  facilitator,
  network,
  token,
  { readReceiverSettlement: async scope => ({ ...scope, totalClaimed: 7n, totalSettled: 7n }) },
);
const result: SettleResult = await api.settle();
// Existing consumers may inspect the property; undefined must never become a transfer.
const transaction: string | undefined = result.transaction;
assert.equal(transaction, undefined);
function consume(result: SettleResult) {
  return result.outcome === "settled"
    ? { outcome: result.outcome, transaction: result.transaction }
    : { outcome: result.outcome };
}
const output = consume(result);
assert.equal(result.outcome, "already-settled");
assert.equal(Object.hasOwn(result, "transaction"), false);
assert.equal(Object.hasOwn(result, "amount"), false);
assert.equal(calls, 0);
assert.deepEqual(JSON.parse(JSON.stringify(output)), { outcome: "already-settled" });
for (const invalid of ["eip155:1\n", "eip155:01", "eip155:", "eip155:9007199254740993"]) {
  let reads = 0;
  await assert.rejects(
    readBatchSettlementReceiverState(
      {
        chain: { id: 1 },
        getChainId: async () => 1,
        readContract: async () => {
          reads += 1;
          return [0n, 0n];
        },
      },
      { network: invalid as `eip155:${string}`, receiver: payTo, token },
    ),
    /canonical/,
  );
  assert.equal(reads, 0);
}
console.log(
  JSON.stringify({ consumer: "built public ESM export", result: output, facilitatorCalls: calls }),
);
