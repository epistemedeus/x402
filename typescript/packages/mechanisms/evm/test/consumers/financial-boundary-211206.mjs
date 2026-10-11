import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildChannelConfig,
  computeChannelId,
  createBatchSettlementClientHooks,
  InMemoryClientChannelStorage,
} from "@x402/evm/batch-settlement/client";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "../..");
const require = createRequire(join(packageRoot, "package.json"));
const cjs = require("@x402/evm/batch-settlement/client");

if (typeof cjs.createBatchSettlementClientHooks !== "function") {
  throw new Error("CJS batch-settlement client does not export createBatchSettlementClientHooks");
}
if (typeof cjs.InMemoryClientChannelStorage !== "function") {
  throw new Error("CJS batch-settlement client does not export InMemoryClientChannelStorage");
}

const declarations = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path);
    else if (name.endsWith(".d.ts") || name.endsWith(".d.mts")) declarations.push(path);
  }
}
walk(join(packageRoot, "dist"));
const declarationText = declarations.map(path => readFileSync(path, "utf8")).join("\n");
if (!declarationText.includes("effectiveAmount")) {
  throw new Error("built declarations do not include effectiveAmount");
}
if (!declarationText.includes("acceptSettlementResult")) {
  throw new Error("built declarations do not include acceptSettlementResult");
}

const payer = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const receiver = "0x9876543210987654321098765432109876543210";
const token = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const network = "eip155:84532";
const tx = `0x${"ab".repeat(32)}`;
const storage = new InMemoryClientChannelStorage();
const deps = {
  signer: { address: payer, signTypedData: async () => "0xsig" },
  storage,
  salt: `0x${"00".repeat(32)}`,
};
const requirements = {
  scheme: "batch-settlement",
  network,
  amount: "0",
  asset: token,
  payTo: receiver,
  maxTimeoutSeconds: 60,
  extra: {
    name: "USDC",
    version: "2",
    receiverAuthorizer: "0x1111111111111111111111111111111111111111",
    withdrawDelay: 900,
  },
};
const config = buildChannelConfig(deps, requirements);
const channelId = computeChannelId(config, network);
await storage.set(channelId.toLowerCase(), {
  chargedCumulativeAmount: "1000",
  balance: "10000",
});
const hooks = createBatchSettlementClientHooks(deps);
const payload = {
  x402Version: 2,
  accepted: requirements,
  payload: {
    type: "refund",
    channelConfig: config,
    voucher: { channelId, maxClaimableAmount: "1000", signature: "0xdead" },
    amount: "2000",
  },
};
let rejected = false;
try {
  await hooks.onPaymentResponse({
    paymentPayload: payload,
    requirements,
    settleResponse: {
      success: true,
      transaction: tx,
      network,
      amount: "1",
      payer,
      extra: { channelState: { channelId, balance: "9999", refundNonce: "1" } },
    },
  });
} catch (error) {
  rejected = true;
  if (!(error instanceof Error) || !/unknown/.test(error.message)) {
    throw error;
  }
}
if (!rejected)
  throw new Error("built client consumed a refund amount other than the admitted amount");
const after = await storage.get(channelId.toLowerCase());
if (after?.balance !== "10000" || after?.chargedCumulativeAmount !== "1000") {
  throw new Error(`built client changed local balances: ${JSON.stringify(after)}`);
}

const cjsStorage = new cjs.InMemoryClientChannelStorage();
await cjsStorage.set(channelId.toLowerCase(), {
  chargedCumulativeAmount: "1000",
  balance: "10000",
});
const cjsHooks = cjs.createBatchSettlementClientHooks({ ...deps, storage: cjsStorage });
await cjsHooks.onPaymentResponse({
  paymentPayload: payload,
  requirements,
  settleResponse: {
    success: true,
    transaction: tx,
    network,
    amount: "2000",
    payer,
    extra: { channelState: { channelId, balance: "8000", refundNonce: "1" } },
  },
});
const cjsAfter = await cjsStorage.get(channelId.toLowerCase());
if (cjsAfter?.balance !== "8000") {
  throw new Error(
    `built CJS client did not apply the admitted partial refund: ${JSON.stringify(cjsAfter)}`,
  );
}

console.log(
  JSON.stringify({
    consumer: "esm+cjs+declarations",
    rejectedWrongAmount: true,
    appliedAdmittedPartial: cjsAfter.balance,
  }),
);
