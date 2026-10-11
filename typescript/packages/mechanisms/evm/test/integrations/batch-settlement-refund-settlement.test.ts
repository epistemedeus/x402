/**
 * Local Anvil reproduction of x402-foundation/x402 issue 3730.
 *
 * The chain is loopback only. Keys are Anvil's published defaults. No mainnet
 * or testnet transaction is sent. Multicall3 bytecode in the fixture was
 * compiled locally from mds1/multicall Multicall3.sol 0.8.12 before this replay.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  concat,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  getContractAddress,
  http,
  publicActions,
  parseEventLogs,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402HTTPResourceServer, x402ResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { toClientEvmSigner, toFacilitatorEvmSigner } from "@x402/evm";
import {
  BatchSettlementEvmScheme as ClientScheme,
  InMemoryClientChannelStorage,
  type BatchSettlementClientContext,
} from "@x402/evm/batch-settlement/client";
import {
  BatchSettlementEvmScheme as ServerScheme,
  readBatchSettlementReceiverState,
  type BatchSettlementChannelManager,
} from "@x402/evm/batch-settlement/server";
import { BatchSettlementEvmScheme as FacilitatorScheme } from "@x402/evm/batch-settlement/facilitator";
import {
  BATCH_SETTLEMENT_ADDRESS,
  ERC3009_DEPOSIT_COLLECTOR_ADDRESS,
} from "../../src/batch-settlement/constants";

const NETWORK = `eip155:${foundry.id}`;
const DEPLOYER = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const BATCH_SALT = "0x000000000000000000000000000000000000000000000000e000000005be885c";
const ERC3009_SALT = "0x0000000000000000000000000000000000000000000000001800000007a95284";
const FACILITATOR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const PAYER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const AUTHORIZER_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
const PAY_TO = "0x00000000000000000000000000000000000000cc";
const OTHER_PAY_TO = "0x00000000000000000000000000000000000000dd";
const PRICE = 1000n;
const MINT = 1_000_000n;
const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..", "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..", "..", "..");
const CONTRACTS_OUT = join(REPO_ROOT, "contracts", "evm", "out");
let rpc = "";

const realFetch = globalThis.fetch.bind(globalThis);
const egress: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === "string" || input instanceof URL ? input : input.url;
  const url = new URL(raw);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    egress.push(url.href);
    throw new TypeError(`blocked non-loopback fetch ${url.href}`);
  }
  return realFetch(input, init);
}) as typeof fetch;

type Balances = { payTo: string; payer: string; settlement: string };

interface World {
  publicClient: PublicClient;
  token: `0x${string}`;
  tokenAbi: readonly unknown[];
  channels: BatchSettlementChannelManager;
  otherChannels: BatchSettlementChannelManager;
  otherTokenChannels: BatchSettlementChannelManager;
  wrongNetworkChannels: BatchSettlementChannelManager;
  clientScheme: ClientScheme;
  clientState: () => Promise<(BatchSettlementClientContext | undefined)[]>;
  serverRefundState: () => Promise<
    {
      balance: string;
      totalClaimed: string;
      chargedCumulativeAmount: string;
      unresolved: boolean;
    }[]
  >;
  api: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  paidFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  facilitatorSettle: (
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ) => Promise<SettleResponse>;
  balances: () => Promise<Balances>;
  settleCalls: number;
  writes: string[];
  signatures: number;
  payerSignatures: number;
  loseNextReceipt: (functionName: string, replies?: number) => void;
  replayLast: () => Promise<SettleResponse>;
  holdNextResponse: (action: string) => { entered: Promise<void>; release: () => void };
}

let anvil: ChildProcess | undefined;

function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("loopback port was not assigned"));
        return;
      }
      const { port } = address;
      server.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

async function startOwnedAnvil(): Promise<ChildProcess> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const port = await reserveLoopbackPort();
    const candidate = `http://127.0.0.1:${port}`;
    const stderr: Buffer[] = [];
    const child = spawn(
      "anvil",
      ["--host", "127.0.0.1", "--port", String(port), "--chain-id", String(foundry.id)],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 8) stderr.push(chunk);
    });
    const probe = createPublicClient({ transport: http(candidate) });
    let ready = false;
    for (let i = 0; i < 100; i += 1) {
      if (child.exitCode !== null) break;
      try {
        await probe.getChainId();
        ready = true;
        break;
      } catch {
        await sleep(100);
      }
    }
    if (ready) {
      rpc = candidate;
      console.log(
        JSON.stringify({ ownedAnvil: child.pid, host: "127.0.0.1", port, chainId: foundry.id }),
      );
      return child;
    }
    const detail = Buffer.concat(stderr).toString("utf8");
    if (child.exitCode === null) child.kill("SIGTERM");
    await waitForExit(child);
    const inUse = /EADDRINUSE|address already in use/i.test(detail);
    lastError = new Error(
      inUse
        ? `anvil loopback port ${port} was already in use`
        : `anvil did not accept loopback RPC on 127.0.0.1:${port}: ${detail.slice(0, 400)}`,
    );
    if (!inUse) throw lastError;
  }
  throw lastError ?? new Error("anvil did not accept loopback RPC");
}

function artifact(name: string): { abi: readonly unknown[]; bytecode: { object: `0x${string}` } } {
  return JSON.parse(readFileSync(join(CONTRACTS_OUT, `${name}.sol`, `${name}.json`), "utf8"));
}

async function waitForExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  const [code] = (await Promise.race([
    once(child, "exit"),
    sleep(5000).then(() => ["timeout"] as const),
  ])) as [number | null | "timeout"];
  if (code === "timeout") {
    child.kill("SIGKILL");
    const [killed] = (await once(child, "exit")) as [number | null];
    return killed;
  }
  return code;
}

async function deployCreate2(
  wallet: WalletClient,
  reader: PublicClient,
  initCode: `0x${string}`,
  salt: `0x${string}`,
): Promise<`0x${string}`> {
  const address = getContractAddress({
    opcode: "CREATE2",
    from: DEPLOYER,
    salt,
    bytecode: initCode,
  });
  const hash = await wallet.sendTransaction({ to: DEPLOYER, data: concat([salt, initCode]) });
  await reader.waitForTransactionReceipt({ hash });
  if ((await reader.getCode({ address })) === "0x") {
    throw new Error(`no code at ${address}`);
  }
  return address;
}

function wrapPaidFetch(
  fetchImpl: typeof fetch,
  client: x402Client,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const httpClient = new x402HTTPClient(client);
  return async (input, init) => {
    const request = new Request(input, init);
    const first = await fetchImpl(request);
    if (first.status !== 402) return first;
    const bodyText = await first.text();
    const body = bodyText ? JSON.parse(bodyText) : undefined;
    const paymentRequired = httpClient.getPaymentRequiredResponse(
      name => first.headers.get(name),
      body,
    );
    const paymentPayload = await client.createPaymentPayload(paymentRequired);
    const paid = request.clone();
    for (const [key, value] of Object.entries(
      httpClient.encodePaymentSignatureHeader(paymentPayload),
    )) {
      paid.headers.set(key, value);
    }
    const second = await fetchImpl(paid);
    await httpClient.processPaymentResult(
      paymentPayload,
      name => second.headers.get(name),
      second.status,
    );
    return second;
  };
}

describe.sequential("issue 3730 refund settlement", () => {
  it("imports the receiver and server scheme from the public package export", async () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      exports: { "./batch-settlement/server": { import: { default: string } } };
    };
    const published = pkg.exports["./batch-settlement/server"].import.default;
    expect(published).toBe("./dist/esm/batch-settlement/server/index.mjs");
    const loaded = (await import(pathToFileURL(join(PACKAGE_ROOT, published)).href)) as {
      readBatchSettlementReceiverState: typeof readBatchSettlementReceiverState;
      BatchSettlementEvmScheme: typeof ServerScheme;
    };
    const scope = {
      network: "eip155:" as const,
      receiver: PAY_TO,
      token: PAY_TO,
    };
    const client = {
      chain: { id: 0 },
      getChainId: async () => 0,
      readContract: async () => [0n, 0n] as const,
    };
    await expect(readBatchSettlementReceiverState(client, scope)).rejects.toThrow(
      /canonical unsigned eip155/,
    );
    await expect(loaded.readBatchSettlementReceiverState(client, scope)).rejects.toThrow(
      /canonical unsigned eip155/,
    );
    expect(new ServerScheme(PAY_TO).createChannelManager).toBeTypeOf("function");
    expect(CONTRACTS_OUT.endsWith(join("contracts", "evm", "out"))).toBe(true);
    expect(rpc.startsWith("http://127.0.0.1:")).toBe(true);
    expect(new URL(rpc).hostname).toBe("127.0.0.1");
    expect(new URL(rpc).port).not.toBe("");
  });

  beforeAll(async () => {
    anvil = await startOwnedAnvil();
  }, 30_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    if (anvil) {
      if (anvil.exitCode === null && anvil.signalCode === null) anvil.kill("SIGTERM");
      const code = await waitForExit(anvil);
      console.log(
        JSON.stringify({ ownedAnvil: anvil.pid, exitCode: code, signal: anvil.signalCode }),
      );
      expect(anvil.exitCode !== null || anvil.signalCode !== null).toBe(true);
    }
    expect(egress).toEqual([]);
  });

  async function boot(opts?: {
    failSettles?: number;
    unknownSettles?: number;
    misreportNetwork?: "different";
    withReader?: boolean;
    selfManaged?: boolean;
    misreportRefund?: "foreign" | "malformed";
  }): Promise<World> {
    const chain = { ...foundry, rpcUrls: { default: { http: [rpc] } } };
    await realFetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_reset", params: [] }),
    });
    const reader = createPublicClient({ chain, transport: http(rpc), pollingInterval: 50 });
    const nodeWallet = createWalletClient({
      account: FACILITATOR,
      chain,
      transport: http(rpc),
      pollingInterval: 50,
    }).extend(publicActions);
    const multicall3 = readFileSync(
      join(HERE, "fixtures/multicall3-creation.hex"),
      "utf8",
    ).trim() as `0x${string}`;
    const multicallHash = await nodeWallet.sendTransaction({ data: multicall3 });
    const deployedMulticall = (await reader.waitForTransactionReceipt({ hash: multicallHash }))
      .contractAddress;
    if (!deployedMulticall) throw new Error("multicall deploy failed");
    const runtime = await reader.getCode({ address: deployedMulticall });
    await reader.request({
      method: "anvil_setCode",
      params: ["0xcA11bde05977b3631167028862bE2a173976CA11", runtime],
    });

    const settlementArtifact = artifact("x402BatchSettlement");
    const collectorArtifact = artifact("ERC3009DepositCollector");
    const settlement = await deployCreate2(
      nodeWallet,
      reader,
      settlementArtifact.bytecode.object,
      BATCH_SALT,
    );
    expect(settlement.toLowerCase()).toBe(BATCH_SETTLEMENT_ADDRESS.toLowerCase());
    const collectorInit = concat([
      collectorArtifact.bytecode.object,
      encodeAbiParameters([{ type: "address" }], [settlement]),
    ]);
    const collector = await deployCreate2(nodeWallet, reader, collectorInit, ERC3009_SALT);
    expect(collector.toLowerCase()).toBe(ERC3009_DEPOSIT_COLLECTOR_ADDRESS.toLowerCase());

    const tokenArtifact = artifact("MockERC3009Token");
    const payer = privateKeyToAccount(PAYER_KEY);
    const tokenHash = await nodeWallet.deployContract({
      abi: tokenArtifact.abi,
      bytecode: tokenArtifact.bytecode.object,
      args: ["Mock USD", "MUSD", 6],
    });
    const token = (await reader.waitForTransactionReceipt({ hash: tokenHash })).contractAddress;
    if (!token) throw new Error("token deploy failed");
    await reader.waitForTransactionReceipt({
      hash: await nodeWallet.writeContract({
        address: token,
        abi: tokenArtifact.abi,
        functionName: "mint",
        args: [payer.address, MINT],
      }),
    });

    const authorizer = privateKeyToAccount(AUTHORIZER_KEY);
    const actualSigner = toFacilitatorEvmSigner({ ...nodeWallet, address: FACILITATOR });
    const writes: string[] = [];
    let lostFunction: string | undefined;
    let lostReplies = 0;
    let lastFunction: string | undefined;
    const facilitatorSigner = {
      ...actualSigner,
      writeContract: async (args: Parameters<typeof actualSigner.writeContract>[0]) => {
        writes.push(args.functionName);
        lastFunction = args.functionName;
        return actualSigner.writeContract(args);
      },
      waitForTransactionReceipt: async (
        args: Parameters<typeof actualSigner.waitForTransactionReceipt>[0],
      ) => {
        const receipt = await actualSigner.waitForTransactionReceipt(args);
        if (lostFunction && lostFunction === lastFunction) {
          lostReplies -= 1;
          if (lostReplies === 0) lostFunction = undefined;
          throw new Error("injected lost reply after the actual receipt was mined");
        }
        return receipt;
      },
    };
    let signatures = 0;
    const authorizerSigner = {
      address: authorizer.address,
      signTypedData: (params: Parameters<typeof authorizer.signTypedData>[0]) => {
        signatures += 1;
        return authorizer.signTypedData(params);
      },
    };
    const facilitator = new x402Facilitator().register(
      NETWORK,
      new FacilitatorScheme(facilitatorSigner, authorizerSigner),
    );
    let settleCalls = 0;
    let failSettles = opts?.failSettles ?? 0;
    let unknownSettles = opts?.unknownSettles ?? 0;
    let lastRequest: { payload: PaymentPayload; requirements: PaymentRequirements } | undefined;
    let heldResponse: { action: string; entered: () => void; waiting: Promise<void> } | undefined;
    const facilitatorSettle = async (
      payload: PaymentPayload,
      requirements: PaymentRequirements,
    ) => {
      const action = (payload.payload as { type?: string }).type;
      if (action === "settle") {
        settleCalls += 1;
        if (failSettles > 0) {
          failSettles -= 1;
          return {
            success: false,
            errorReason: "boom",
            errorMessage: "forced settle failure",
            transaction: "",
            network: requirements.network,
          } satisfies SettleResponse;
        }
        if (unknownSettles > 0) {
          unknownSettles -= 1;
          return {
            success: true,
            transaction: "",
            amount: "1",
            network: requirements.network,
          } satisfies SettleResponse;
        }
      }
      lastRequest = {
        payload: structuredClone(payload),
        requirements: structuredClone(requirements),
      };
      const settled = await facilitator.settle(payload, requirements);
      if (heldResponse?.action === action) {
        const held = heldResponse;
        heldResponse = undefined;
        held.entered();
        await held.waiting;
      }
      if (action === "settle" && opts?.misreportNetwork === "different") {
        return { ...settled, network: "eip155:1" };
      }
      if (action === "refund" && opts?.misreportRefund === "foreign") {
        return { ...settled, network: "eip155:1" };
      }
      if (action === "refund" && opts?.misreportRefund === "malformed") {
        return { ...settled, transaction: "0x123" };
      }
      return settled;
    };
    const facilitatorClient = {
      verify: (payload: PaymentPayload, requirements: PaymentRequirements) =>
        facilitator.verify(payload, requirements),
      settle: facilitatorSettle,
      getSupported: async () => facilitator.getSupported(),
    };

    const readReceiverSettlement = (
      scope: Parameters<typeof readBatchSettlementReceiverState>[1],
    ) => readBatchSettlementReceiverState(reader, scope);
    const serverScheme = new ServerScheme(PAY_TO, {
      enforceMinDeposit: false,
      ...(opts?.selfManaged ? { receiverAuthorizerSigner: authorizerSigner } : {}),
    });
    const resourceServer = new x402ResourceServer(facilitatorClient).register(
      NETWORK,
      serverScheme,
    );
    const channels = serverScheme.createChannelManager(
      facilitatorClient,
      NETWORK,
      token,
      opts?.withReader === false ? {} : { readReceiverSettlement },
    );
    const otherScheme = new ServerScheme(OTHER_PAY_TO, { enforceMinDeposit: false });
    const otherChannels = otherScheme.createChannelManager(facilitatorClient, NETWORK, token, {
      readReceiverSettlement,
    });
    const otherTokenChannels = new ServerScheme(PAY_TO, {
      enforceMinDeposit: false,
    }).createChannelManager(
      facilitatorClient,
      NETWORK,
      "0x00000000000000000000000000000000000000aa",
      { readReceiverSettlement },
    );
    const wrongNetworkChannels = new ServerScheme(PAY_TO, {
      enforceMinDeposit: false,
    }).createChannelManager(facilitatorClient, "eip155:1", token, { readReceiverSettlement });
    const server = new x402HTTPResourceServer(resourceServer, {
      "GET /weather": {
        accepts: {
          scheme: "batch-settlement",
          network: NETWORK,
          payTo: PAY_TO,
          price: {
            asset: token,
            amount: String(PRICE),
            extra: { name: "Mock USD", version: "1", assetTransferMethod: "eip3009" },
          },
          maxTimeoutSeconds: 60,
        },
        description: "Weather",
        mimeType: "application/json",
      },
    });
    await server.initialize();

    const api = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const adapter = {
        getHeader: (name: string) => request.headers.get(name) ?? undefined,
        getMethod: () => request.method,
        getPath: () => url.pathname,
        getUrl: () => request.url,
        getAcceptHeader: () => request.headers.get("accept") ?? "",
        getUserAgent: () => request.headers.get("user-agent") ?? "",
      };
      const context = { adapter, path: url.pathname, method: request.method };
      const result = await server.processHTTPRequest(context);
      if (result.type === "payment-error") {
        return new Response(JSON.stringify(result.response.body ?? {}), {
          status: result.response.status,
          headers: result.response.headers,
        });
      }
      if (result.type === "no-payment-required") return new Response("{}");
      const settled = await server.processSettlement(
        result.paymentPayload,
        result.paymentRequirements,
        result.declaredExtensions,
        { request: context },
        undefined,
        result.beforeHandlerSettlement,
      );
      if (!settled.success) {
        return new Response(JSON.stringify(settled.response.body ?? {}), {
          status: settled.response.status,
          headers: settled.response.headers,
        });
      }
      return new Response('{"temperature":21}', { status: 200, headers: settled.headers });
    };

    const client = new x402Client();
    const clientStorage = new InMemoryClientChannelStorage();
    const clientIds = new Set<string>();
    const actualClientSigner = toClientEvmSigner(payer, reader);
    let payerSignatures = 0;
    const clientSigner = {
      ...actualClientSigner,
      signTypedData: (params: Parameters<typeof actualClientSigner.signTypedData>[0]) => {
        payerSignatures += 1;
        return actualClientSigner.signTypedData(params);
      },
    };
    const clientScheme = new ClientScheme(clientSigner, {
      depositPolicy: { depositMultiplier: 5 },
      storage: {
        get: key => {
          clientIds.add(key);
          return clientStorage.get(key);
        },
        set: (key, context) => {
          clientIds.add(key);
          return clientStorage.set(key, context);
        },
        delete: key => clientStorage.delete(key),
      },
    });
    client.register("eip155:*", clientScheme);
    client.setSpendControls({ allowedAssets: [{ network: NETWORK, asset: token }] });
    const paidFetch = wrapPaidFetch(api, client);

    const balanceOf = async (address: `0x${string}`) =>
      String(
        await reader.readContract({
          address: token,
          abi: tokenArtifact.abi,
          functionName: "balanceOf",
          args: [address],
        }),
      );

    return {
      publicClient: reader,
      token,
      tokenAbi: tokenArtifact.abi,
      channels,
      otherChannels,
      otherTokenChannels,
      wrongNetworkChannels,
      clientScheme,
      clientState: async () =>
        structuredClone(await Promise.all(Array.from(clientIds, key => clientStorage.get(key)))),
      serverRefundState: async () =>
        (await serverScheme.getStorage().list()).map(channel => ({
          balance: channel.balance,
          totalClaimed: channel.totalClaimed,
          chargedCumulativeAmount: channel.chargedCumulativeAmount,
          unresolved: serverScheme.readRetainedRefund(channel.channelId)?.unresolved ?? false,
        })),
      api,
      paidFetch,
      facilitatorSettle,
      writes,
      get signatures() {
        return signatures;
      },
      get payerSignatures() {
        return payerSignatures;
      },
      loseNextReceipt: (functionName, replies = 1) => {
        lostFunction = functionName;
        lostReplies = replies;
      },
      replayLast: async () => {
        if (!lastRequest) throw new Error("no original request to reconcile");
        return facilitatorSettle(lastRequest.payload, lastRequest.requirements);
      },
      holdNextResponse: action => {
        let entered!: () => void;
        let release!: () => void;
        const arrived = new Promise<void>(resolve => {
          entered = resolve;
        });
        const waiting = new Promise<void>(resolve => {
          release = resolve;
        });
        heldResponse = { action, entered, waiting };
        return { entered: arrived, release };
      },
      balances: async () => ({
        payTo: await balanceOf(PAY_TO),
        payer: await balanceOf(payer.address),
        settlement: await balanceOf(BATCH_SETTLEMENT_ADDRESS),
      }),
      get settleCalls() {
        return settleCalls;
      },
    };
  }

  async function pay(world: World, requests = 3): Promise<void> {
    for (let i = 0; i < requests; i++) {
      const response = await world.paidFetch("http://127.0.0.1/weather");
      expect(response.status).toBe(200);
      await response.text();
    }
  }

  it("moves server-refunded claims on flush and does not settle them twice", async () => {
    const world = await boot();
    await pay(world);
    expect(await world.balances()).toEqual({ payTo: "0", payer: "990000", settlement: "10000" });

    await world.channels.refund();
    expect(await world.balances()).toEqual({ payTo: "0", payer: "997000", settlement: "3000" });

    const before = world.settleCalls;
    await world.channels.stop({ flush: true });
    expect(await world.balances()).toEqual({ payTo: "3000", payer: "997000", settlement: "0" });
    expect(world.settleCalls).toBe(before + 1);

    const again = world.settleCalls;
    await world.channels.claimAndSettle();
    expect(world.settleCalls).toBe(again);
    expect(await world.balances()).toEqual({ payTo: "3000", payer: "997000", settlement: "0" });
  }, 120_000);

  it("moves an idle server refund through the settle interval", async () => {
    const world = await boot();
    await pay(world);
    const refunded = await world.channels.refundIdleChannels({ idleSecs: 0 });
    expect(refunded.length).toBe(1);
    expect(await world.balances()).toMatchObject({ payTo: "0", settlement: "3000" });

    const settles: string[] = [];
    const errors: string[] = [];
    const before = world.settleCalls;
    world.channels.start({
      settleIntervalSecs: 1,
      onSettle: result => {
        if (result.outcome === "settled") settles.push(result.transaction);
      },
      onError: error => {
        errors.push(error instanceof Error ? error.message : String(error));
      },
    });
    for (let i = 0; i < 80 && settles.length === 0 && errors.length === 0; i++) {
      await sleep(250);
    }
    await world.channels.stop();
    for (let i = 0; i < 40 && settles.length === 0 && errors.length === 0; i++) {
      await sleep(250);
    }
    expect(errors).toEqual([]);
    expect(settles).toHaveLength(1);
    expect(world.settleCalls).toBe(before + 1);
    expect(await world.balances()).toEqual({ payTo: "3000", payer: "997000", settlement: "0" });
  }, 120_000);

  it("moves a client-initiated refund on graceful flush", async () => {
    const world = await boot();
    await pay(world);
    await world.clientScheme.refund("http://127.0.0.1/weather", { fetch: world.api });
    expect(await world.balances()).toEqual({ payTo: "0", payer: "997000", settlement: "3000" });

    world.channels.start({
      claimIntervalSecs: 3600,
      settleIntervalSecs: 3600,
      refundIntervalSecs: 3600,
    });
    await world.channels.stop({ flush: true });
    expect(await world.balances()).toEqual({ payTo: "3000", payer: "997000", settlement: "0" });
  }, 120_000);

  it.each([false, true])(
    "receives the exact HTTP refund retry with self-managed authorizer %s and preserves pending capacity",
    async selfManaged => {
      const world = await boot({ selfManaged });
      await pay(world);
      const before = await world.clientState();
      // The resource server has one supported automatic receipt retry.
      world.loseNextReceipt("multicall", 2);
      await expect(
        world.clientScheme.refund("http://127.0.0.1/weather", { fetch: world.api }),
      ).rejects.toThrow(/settlement_pending/);
      expect(await world.clientState()).toEqual(before);
      const count = world.writes.length;
      const signatures = world.signatures;
      const payerSignatures = world.payerSignatures;
      await expect(world.paidFetch("http://127.0.0.1/weather")).rejects.toThrow(/unresolved/);
      await expect(
        world.clientScheme.refund("http://127.0.0.1/weather", { amount: "1000", fetch: world.api }),
      ).rejects.toThrow(/changed terms/);
      expect(world.payerSignatures).toBe(payerSignatures);
      expect(world.writes).toHaveLength(count);
      const reconciled = await world.clientScheme.refund("http://127.0.0.1/weather", {
        fetch: world.api,
      });
      expect(reconciled.success).toBe(true);
      expect(reconciled.transaction).toMatch(/^0x[0-9a-fA-F]{64}$/);
      expect(world.writes).toHaveLength(count);
      expect(world.signatures).toBe(signatures);
      expect(world.payerSignatures).toBe(payerSignatures);
      expect((await world.clientState()).every(channel => channel === undefined)).toBe(true);
      const receipt = await world.publicClient.getTransactionReceipt({
        hash: reconciled.transaction as `0x${string}`,
      });
      expect(receipt.status).toBe("success");
      await world.channels.stop({ flush: true });
      expect(await world.balances()).toEqual({ payTo: "3000", payer: "997000", settlement: "0" });
      console.log(
        JSON.stringify({
          receiving: "HTTP refund pending then original receipt confirmation",
          transaction: reconciled.transaction,
          receiptStatus: receipt.status,
          capacityUnchangedWhilePending: true,
          secondBroadcasts: 0,
          secondAuthorizerSignatures: 0,
          secondPayerSignatures: 0,
          balances: await world.balances(),
        }),
      );
    },
    120_000,
  );

  it.each([undefined, "1000"])(
    "shares concurrent actual HTTP refund amount %s without duplicate signing or capacity release",
    async amount => {
      const world = await boot();
      await pay(world);
      const before = await world.clientState();
      const held = world.holdNextResponse("refund");
      const options = { ...(amount !== undefined ? { amount } : {}), fetch: world.api };
      const first = world.clientScheme.refund("http://127.0.0.1/weather", options);
      await held.entered;
      const writes = world.writes.length;
      const authorizerSignatures = world.signatures;
      const payerSignatures = world.payerSignatures;
      const second = world.clientScheme.refund("http://127.0.0.1/weather", options);
      await sleep(20);
      const writesBeforeReply = world.writes.length;
      const authorizersBeforeReply = world.signatures;
      const payerBeforeReply = world.payerSignatures;
      expect(await world.clientState()).toEqual(before);
      held.release();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(secondResult).toEqual(firstResult);
      expect(writesBeforeReply).toBe(writes);
      expect(authorizersBeforeReply).toBe(authorizerSignatures);
      expect(payerBeforeReply).toBe(payerSignatures);
      const states = await world.clientState();
      if (amount === undefined) expect(states.every(channel => channel === undefined)).toBe(true);
      else expect(states[0]).toMatchObject({ balance: "9000", chargedCumulativeAmount: "3000" });
      await world.channels.stop({ flush: true });
      expect(await world.balances()).toEqual(
        amount === undefined
          ? { payTo: "3000", payer: "997000", settlement: "0" }
          : { payTo: "3000", payer: "991000", settlement: "6000" },
      );
    },
    120_000,
  );

  it.each(["foreign", "malformed"] as const)(
    "keeps client capacity unchanged after a %s refund success assertion",
    async misreportRefund => {
      const world = await boot({ misreportRefund });
      await pay(world);
      const before = await world.clientState();
      const serverBefore = await world.serverRefundState();
      await expect(
        world.clientScheme.refund("http://127.0.0.1/weather", { fetch: world.api }),
      ).rejects.toThrow(/unknown|network|hash|confirmed/);
      expect(await world.clientState()).toEqual(before);
      expect(await world.serverRefundState()).toEqual(
        serverBefore.map(channel => ({ ...channel, unresolved: true })),
      );
    },
    120_000,
  );

  it("keeps a zero-unclaimed channel from settling again after claimAndSettle", async () => {
    const world = await boot();
    await pay(world);
    await world.channels.claimAndSettle();
    expect(await world.balances()).toEqual({ payTo: "3000", payer: "990000", settlement: "7000" });
    await world.channels.refund();
    expect(await world.balances()).toEqual({ payTo: "3000", payer: "997000", settlement: "0" });
    const calls = world.settleCalls;
    await world.channels.claimAndSettle();
    expect(world.settleCalls).toBe(calls);
    expect(await world.balances()).toEqual({ payTo: "3000", payer: "997000", settlement: "0" });
  }, 120_000);

  it("does not settle another payTo, token, or network", async () => {
    const world = await boot();
    await pay(world);
    await world.channels.refund();
    const before = await world.balances();
    await world.otherChannels.claimAndSettle();
    await world.otherTokenChannels.claimAndSettle();
    await expect(world.wrongNetworkChannels.claimAndSettle()).rejects.toThrow(/does not match/);
    expect(await world.balances()).toEqual(before);
    expect(before).toEqual({ payTo: "0", payer: "997000", settlement: "3000" });
  }, 120_000);

  it("concurrent claim, refund, and settle still transfer the claimed balance once", async () => {
    const world = await boot();
    await pay(world);
    await Promise.allSettled([
      world.channels.claim(),
      world.channels.refund(),
      world.channels.settle(),
    ]);
    await world.channels.refund().catch(() => undefined);
    await world.channels.claimAndSettle().catch(() => undefined);
    expect(await world.balances()).toEqual({ payTo: "3000", payer: "997000", settlement: "0" });
    const calls = world.settleCalls;
    await world.channels.claimAndSettle();
    expect(world.settleCalls).toBe(calls);
    expect(await world.balances()).toEqual({ payTo: "3000", payer: "997000", settlement: "0" });
  }, 120_000);

  it("retries one failed settle and still transfers the claimed amount once", async () => {
    const world = await boot({ failSettles: 1 });
    await pay(world);
    await world.channels.refund();
    await expect(world.channels.claimAndSettle()).rejects.toThrow(/Settle failed/);
    expect(await world.balances()).toMatchObject({ payTo: "0", settlement: "3000" });
    await world.channels.claimAndSettle();
    expect(await world.balances()).toEqual({ payTo: "3000", payer: "997000", settlement: "0" });
  }, 120_000);

  it("does not treat an unknown settle response as a completed transfer", async () => {
    const world = await boot({ unknownSettles: 1 });
    await pay(world);
    await world.channels.refund();
    await expect(world.channels.claimAndSettle()).rejects.toThrow(/outcome unknown/);
    expect(await world.balances()).toMatchObject({ payTo: "0", settlement: "3000" });
    await expect(world.channels.claimAndSettle()).rejects.toThrow(/unresolved/);
    expect(await world.balances()).toEqual({ payTo: "0", payer: "997000", settlement: "3000" });
  }, 120_000);

  it("does not promote a different-network settle response as this manager's completion", async () => {
    const world = await boot({ misreportNetwork: "different" });
    await pay(world);
    await world.channels.refund();
    await expect(world.channels.claimAndSettle()).rejects.toThrow(
      /did not name this manager's network/,
    );
    expect(await world.balances()).toEqual({ payTo: "3000", payer: "997000", settlement: "0" });
    const calls = world.settleCalls;
    await expect(world.channels.claimAndSettle()).rejects.toThrow(/unresolved/);
    expect(world.settleCalls).toBe(calls);
    expect(await world.balances()).toEqual({ payTo: "3000", payer: "997000", settlement: "0" });
  }, 120_000);

  it("concurrent settle calls transfer the claimed balance once", async () => {
    const world = await boot();
    await pay(world);
    await world.channels.refund();
    const [first, second] = await Promise.all([world.channels.settle(), world.channels.settle()]);
    expect(first.transaction).toBe(second.transaction);
    expect(first.transaction).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(await world.balances()).toEqual({ payTo: "3000", payer: "997000", settlement: "0" });
    expect(world.settleCalls).toBe(1);
  }, 120_000);

  it("returns the built noop contract only after a real receipt and equal scoped totals", async () => {
    const world = await boot();
    await pay(world);
    await world.channels.refund();
    const first = await world.channels.settle();
    expect(first.outcome).toBe("settled");
    if (first.outcome !== "settled") throw new Error("expected a transfer");
    const receipt = await world.publicClient.getTransactionReceipt({
      hash: first.transaction as `0x${string}`,
    });
    expect(receipt.status).toBe("success");
    expect(receipt.transactionHash).toBe(first.transaction);
    const settled = parseEventLogs({
      abi: artifact("x402BatchSettlement").abi,
      eventName: "Settled",
      logs: receipt.logs,
    }) as unknown as Array<{ args: { receiver: string; token: string; amount: bigint } }>;
    expect(
      settled.some(
        log =>
          log.args.receiver.toLowerCase() === PAY_TO.toLowerCase() &&
          log.args.token.toLowerCase() === world.token.toLowerCase() &&
          log.args.amount === 3000n,
      ),
    ).toBe(true);
    const calls = world.writes.length;
    const second = await world.channels.settle();
    expect(JSON.parse(JSON.stringify(second))).toEqual({ outcome: "already-settled" });
    expect(Object.hasOwn(second, "transaction")).toBe(false);
    expect(world.writes).toHaveLength(calls);
    const snapshot = await readBatchSettlementReceiverState(world.publicClient, {
      network: NETWORK,
      receiver: PAY_TO,
      token: world.token,
    });
    expect(snapshot).toMatchObject({ totalClaimed: 3000n, totalSettled: 3000n });
    console.log(
      JSON.stringify({
        receiving: "built public SDK transfer then verified noop",
        transaction: first.transaction,
        receiptStatus: receipt.status,
        network: snapshot.network,
        receiver: snapshot.receiver,
        token: snapshot.token,
        totalClaimed: String(snapshot.totalClaimed),
        totalSettled: String(snapshot.totalSettled),
        noop: second,
        balances: await world.balances(),
      }),
    );
  }, 120_000);

  it.each(["claimWithSignature", "multicall", "settle"])(
    "reconciles a real pending %s transaction without another broadcast",
    async functionName => {
      const world = await boot();
      await pay(world);
      if (functionName === "settle") await world.channels.refund();
      world.loseNextReceipt(functionName);
      const call =
        functionName === "claimWithSignature"
          ? world.channels.claim()
          : functionName === "multicall"
            ? world.channels.refund()
            : world.channels.settle();
      await expect(call).rejects.toThrow(/unresolved/);
      const count = world.writes.length;
      const signatures = world.signatures;
      const reconciled = await world.replayLast();
      expect(reconciled.success).toBe(true);
      expect(reconciled.transaction).toMatch(/^0x[0-9a-fA-F]{64}$/);
      expect(world.writes).toHaveLength(count);
      expect(world.signatures).toBe(signatures);
      const receipt = await world.publicClient.getTransactionReceipt({
        hash: reconciled.transaction as `0x${string}`,
      });
      expect(receipt.status).toBe("success");
      await world.channels.stop();
      world.channels.start();
      await expect(world.channels.claimAndSettle()).rejects.toThrow(/unresolved/);
      await world.channels.stop();
      expect(world.writes).toHaveLength(count);
      const state = await readBatchSettlementReceiverState(world.publicClient, {
        network: NETWORK,
        receiver: PAY_TO,
        token: world.token,
      });
      expect(state.totalClaimed).toBe(3000n);
      expect(state.totalSettled).toBe(functionName === "settle" ? 3000n : 0n);
      // Confirmation is independently received here; it does not silently reset the
      // original manager's unresolved effect or create fresh payer spending capacity.
    },
    120_000,
  );

  it.each(["claim", "refund"] as const)(
    "shares a concurrent actual %s without another signature or broadcast",
    async action => {
      const world = await boot();
      await pay(world);
      const held = world.holdNextResponse(action);
      const first = world.channels[action]();
      await held.entered;
      const count = world.writes.length;
      const signatures = world.signatures;
      const second = world.channels[action]();
      await sleep(20);
      const writesBeforeReply = world.writes.length;
      const signaturesBeforeReply = world.signatures;
      held.release();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(secondResult).toEqual(firstResult);
      expect(writesBeforeReply).toBe(count);
      expect(signaturesBeforeReply).toBe(signatures);
      const snapshot = await readBatchSettlementReceiverState(world.publicClient, {
        network: NETWORK,
        receiver: PAY_TO,
        token: world.token,
      });
      expect(snapshot).toMatchObject({ totalClaimed: 3000n, totalSettled: 0n });
      if (action === "claim") await world.channels.refund();
      await world.channels.stop({ flush: true });
      expect(await world.balances()).toEqual({ payTo: "3000", payer: "997000", settlement: "0" });
    },
    120_000,
  );

  it("waits for an admitted actual refund before one shutdown flush", async () => {
    const world = await boot();
    await pay(world);
    const held = world.holdNextResponse("refund");
    const refund = world.channels.refund();
    await held.entered;
    let stopped = false;
    const firstStop = world.channels.stop({ flush: true }).then(() => {
      stopped = true;
    });
    const secondStop = world.channels.stop({ flush: true });
    await sleep(20);
    expect(stopped).toBe(false);
    expect(await world.balances()).toEqual({ payTo: "0", payer: "997000", settlement: "3000" });
    held.release();
    await refund;
    await Promise.all([firstStop, secondStop]);
    expect(world.settleCalls).toBe(1);
    expect(await world.balances()).toEqual({ payTo: "3000", payer: "997000", settlement: "0" });
    world.channels.start();
    await world.channels.stop({ flush: true });
    expect(world.settleCalls).toBe(1);
  }, 120_000);

  it("keeps a new refund claim admitted while a no-reader settle response is in flight", async () => {
    const world = await boot({ withReader: false });
    await pay(world);
    await world.channels.claim();
    const held = world.holdNextResponse("settle");
    const settling = world.channels.settle();
    await held.entered;
    await pay(world, 1);
    await world.channels.refund();
    held.release();
    await settling;
    expect(await world.balances()).toEqual({ payTo: "3000", payer: "996000", settlement: "1000" });
    await world.channels.stop({ flush: true });
    expect(await world.balances()).toEqual({ payTo: "4000", payer: "996000", settlement: "0" });
    expect(world.settleCalls).toBe(2);
    const writes = world.writes.length;
    await world.channels.stop({ flush: true });
    expect(world.writes).toHaveLength(writes);
  }, 120_000);

  it("checks the connected RPC chain independently of configured chain metadata", async () => {
    const world = await boot();
    await pay(world);
    await world.channels.refund();
    const wrong = createPublicClient({
      chain: { ...foundry, id: 1 },
      transport: http(rpc),
      pollingInterval: 50,
    });
    await expect(
      readBatchSettlementReceiverState(wrong, {
        network: "eip155:1",
        receiver: PAY_TO,
        token: world.token,
      }),
    ).rejects.toThrow(/RPC|connected|chain/);
    expect(await world.balances()).toEqual({ payTo: "0", payer: "997000", settlement: "3000" });
  }, 120_000);
});
