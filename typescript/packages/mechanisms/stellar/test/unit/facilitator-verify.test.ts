import { Buffer } from "buffer";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  Address,
  Networks as StellarNetworks,
  SorobanDataBuilder,
  authorizeEntry,
  buildAuthorizationEntryPreimage,
  rpc,
  Transaction,
  TransactionBuilder,
  Operation,
  Account,
  xdr,
  Keypair,
  Asset,
} from "@stellar/stellar-sdk";
import { Api } from "@stellar/stellar-sdk/rpc";
import { afterEach, beforeEach, beforeAll, describe, expect, it, vi } from "vitest";
import { STELLAR_TESTNET_CAIP2 } from "../../src/constants";
import {
  ExactStellarScheme,
  invalidVerifyResponse,
  validVerifyResponse,
} from "../../src/exact/facilitator/scheme";
import { createEd25519Signer } from "../../src/signer";
import * as stellarUtils from "../../src/utils";
import type { FacilitatorStellarSigner } from "../../src/signer";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

/**
 * Creates a mock transfer event for testing event validation.
 * Follows CAP-46-06 format: Topic: ["transfer", from, to, ...], Data: amount
 * @see https://github.com/stellar/stellar-protocol/blob/master/core/cap-0046-06.md
 *
 * @param params - The parameters object
 * @param params.from - The sender address
 * @param params.to - The recipient address
 * @param params.amount - The transfer amount as bigint
 * @param params.fnName - The function name (defaults to "transfer")
 * @returns A DiagnosticEvent XDR object
 */
function createMockContractEvent({
  from,
  to,
  amount,
  fnName = "transfer",
  contractId,
}: {
  from: string;
  to: string;
  amount: bigint;
  fnName?: string;
  contractId?: xdr.Hash | null;
}): xdr.DiagnosticEvent {
  // symbol for the function name
  const transferSymbol = xdr.ScVal.scvSymbol(fnName);

  const fromKeypair = Keypair.fromPublicKey(from);
  const fromScAddress = xdr.ScVal.scvAddress(
    xdr.ScAddress.scAddressTypeAccount(
      xdr.PublicKey.publicKeyTypeEd25519(fromKeypair.rawPublicKey()),
    ),
  );

  const toKeypair = Keypair.fromPublicKey(to);
  const toScAddress = xdr.ScVal.scvAddress(
    xdr.ScAddress.scAddressTypeAccount(
      xdr.PublicKey.publicKeyTypeEd25519(toKeypair.rawPublicKey()),
    ),
  );

  const amountScVal = xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      lo: xdr.Uint64.fromString(amount.toString()),
      hi: xdr.Int64.fromString("0"),
    }),
  );

  const contractEventV0 = new xdr.ContractEventV0({
    topics: [transferSymbol, fromScAddress, toScAddress],
    data: amountScVal,
  });
  return createMockDiagnosticEvent(
    contractEventV0,
    xdr.ContractEventType.contract(),
    contractId ?? null,
  );
}

/**
 * Creates a mock system diagnostic event (should be ignored by event validator).
 */
function createMockSystemEvent(): xdr.DiagnosticEvent {
  return createMockDiagnosticEvent(
    new xdr.ContractEventV0({ topics: [], data: xdr.ScVal.scvVoid() }),
    xdr.ContractEventType.system(),
  );
}

/**
 * Creates a mock diagnostic event from a ContractEventV0 and event type.
 * This helper function constructs the proper XDR structure for testing
 * contract event validation in the facilitator verification process.
 *
 * @param v0 - The ContractEventV0 containing the event data
 * @param eventType - The contract event type (contract or system)
 * @param contractId - Optional contract ID (null = event has no contract; omit for backward compat)
 * @returns A properly formatted DiagnosticEvent for testing
 */
function createMockDiagnosticEvent(
  v0: xdr.ContractEventV0,
  eventType: ReturnType<typeof xdr.ContractEventType.contract> = xdr.ContractEventType.contract(),
  contractId: xdr.Hash | null = null,
): xdr.DiagnosticEvent {
  const eventBodyXdr = xdr.ContractEventBody.toXDR(
    xdr.ContractEventBody.fromXDR(
      Buffer.concat([Buffer.from([0, 0, 0, 0]), xdr.ContractEventV0.toXDR(v0)]),
    ),
  );
  const contractEvent = new xdr.ContractEvent({
    ext: xdr.ExtensionPoint.fromXDR(Buffer.from([0, 0, 0, 0])),
    contractId,
    type: eventType,
    body: xdr.ContractEventBody.fromXDR(eventBodyXdr),
  });
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: true,
    event: contractEvent,
  });
}

/**
 * Positive i128 ScVal. Callers use amounts that fit in the low 64 bits.
 */
function i128ScVal(amount: bigint): xdr.ScVal {
  const lo = amount & BigInt("0xffffffffffffffff");
  const hi = amount >> 64n;
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      lo: xdr.Uint64.fromString(lo.toString()),
      hi: xdr.Int64.fromString(hi.toString()),
    }),
  );
}

function addressScVal(address: string): xdr.ScVal {
  return xdr.ScVal.scvAddress(new Address(address).toScAddress());
}

function symbolScVal(name: string): xdr.ScVal {
  return xdr.ScVal.scvSymbol(name);
}

function symbolMap(entries: Array<[string, xdr.ScVal]>): xdr.ScVal {
  const sorted = [...entries].sort((left, right) => left[0].localeCompare(right[0]));
  return xdr.ScVal.scvMap(
    sorted.map(([key, val]) => new xdr.ScMapEntry({ key: symbolScVal(key), val })),
  );
}

vi.mock("../../src/utils", async () => {
  const actual = await vi.importActual<typeof stellarUtils>("../../src/utils");
  return {
    ...actual,
    getEstimatedLedgerCloseTimeSeconds: vi.fn().mockResolvedValue(5),
    getNetworkPassphrase: vi.fn(),
    getRpcClient: vi.fn(),
  };
});

describe("ExactStellarScheme#Verify (randomly using 1-2 facilitator signers)", () => {
  const mockServer = {
    simulateTransaction: vi.fn(),
    getLatestLedger: vi.fn(),
  } as unknown as rpc.Server;

  const CLIENT_PUBLIC = "GBBO4ZDDZTSM2IUKQYBAST3CFHNPFXECGEFTGWTA2WELR2BIWDK57UVE";
  // Matches CLIENT_PUBLIC; needed to re-sign fixture auth entries over the CAP-71 V2 preimage
  const CLIENT_SECRET = "SDV3OZOPGIO6GQAVI7T6ZJ7NSNFB26JX6QZYCI64TBC7BAZY6FQVAXXK";
  const FACILITATOR_PUBLIC = "GCQAXB2D77Y4C66CTGVH25H2RMUKMQJGOWUPK7UXGG5MAQBONUEKFQ4P";
  const TRANSACTION_RECIPIENT = "GCHEI4PQEFJOA27MNZRPQNLGURS6KASW76X5UZCUZIXCOJLKXYCXOR2W";
  const ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
  const networkPassphrase = StellarNetworks.TESTNET;
  const account = new Account(CLIENT_PUBLIC, "100");

  const facilitatorSigner1 = createEd25519Signer(
    "SCKB3ECHCPVM4HJPNCQWTQWJJ5XRL6UNKLTTCIH4B7TB22NKJ5GUFMIV",
    STELLAR_TESTNET_CAIP2,
  );
  const facilitatorSigner2 = createEd25519Signer(
    "SA6LFVPCYMDQILBRXQ2B2HRPK6DV2TX4FTQQQHWFPSCSY4H2RTCD3XAK",
    STELLAR_TESTNET_CAIP2,
  );

  let stellarPayload: { transaction: string };
  let baseTransaction: Transaction;
  let baseSorobanData: xdr.SorobanTransactionData | undefined;
  let baseOperation: Operation.InvokeHostFunction;
  let baseFunc: xdr.HostFunction;
  let baseInvokeContractArgs: xdr.InvokeContractArgs;
  let facilitatorSigners: FacilitatorStellarSigner[];
  let facilitator: ExactStellarScheme;
  let validPayload: PaymentPayload;
  let validRequirements: PaymentRequirements;

  // Use a real transaction XDR from shared test (base64 encoded JSON with tx field)
  const signedTxJson =
    "eyJtZXRob2QiOiJ0cmFuc2ZlciIsInR4IjoiQUFBQUFnQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQURsM0lBQUFBQUFBQUFBUUFBQUFFQUFBQUFBQUFBQUFBQUFBQnBGcEdGQUFBQUFBQUFBQUVBQUFBQUFBQUFHQUFBQUFBQUFBQUJVRVhOWHNCeW1uYVAxYTBDVUZoUzMwOENqYzZERGxyRklnbTZTRWc3THdFQUFBQUlkSEpoYm5ObVpYSUFBQUFEQUFBQUVnQUFBQUFBQUFBQVF1NWtZOHprelNLS2hnSUpUMklwMnZMY2dqRUxNMXBnMVlpNDZDaXcxZDhBQUFBU0FBQUFBQUFBQUFDT1JISHdJVkxnYSt4dVl2ZzFacVJsNVFKVy82L2FaRlRLTGljbGFyNEZkd0FBQUFvQUFBQUFBQUFBQUFBQUFBQUFBQ2NRQUFBQUFRQUFBQUVBQUFBQUFBQUFBRUx1WkdQTTVNMGlpb1lDQ1U5aUtkcnkzSUl4Q3pOYVlOV0l1T2dvc05YZlh4amsrOHlZOGhnQUk4ck9BQUFBRUFBQUFBRUFBQUFCQUFBQUVRQUFBQUVBQUFBQ0FBQUFEd0FBQUFwd2RXSnNhV05mYTJWNUFBQUFBQUFOQUFBQUlFTHVaR1BNNU0waWlvWUNDVTlpS2RyeTNJSXhDek5hWU5XSXVPZ29zTlhmQUFBQUR3QUFBQWx6YVdkdVlYUjFjbVVBQUFBQUFBQU5BQUFBUUl2bjJjU3VLbFl5TU96T0pTWnkwc0VaN3dkN1QwYmdSQ0ZxZjg1M3VXQXFVcjE1ZUpycXNqVjROUVpTQW05WXNWbHZEcEUrSFRLc3pUQUVBaTJBRkFnQUFBQUFBQUFBQVZCRnpWN0FjcHAyajlXdEFsQllVdDlQQW8zT2d3NWF4U0lKdWtoSU95OEJBQUFBQ0hSeVlXNXpabVZ5QUFBQUF3QUFBQklBQUFBQUFBQUFBRUx1WkdQTTVNMGlpb1lDQ1U5aUtkcnkzSUl4Q3pOYVlOV0l1T2dvc05YZkFBQUFFZ0FBQUFBQUFBQUFqa1J4OENGUzRHdnNibUw0Tldha1plVUNWdit2Mm1SVXlpNG5KV3ErQlhjQUFBQUtBQUFBQUFBQUFBQUFBQUFBQUFBbkVBQUFBQUFBQUFBQkFBQUFBQUFBQUFJQUFBQUFBQUFBQUVMdVpHUE01TTBpaW9ZQ0NVOWlLZHJ5M0lJeEN6TmFZTldJdU9nb3NOWGZBQUFBQmdBQUFBRlFSYzFld0hLYWRvL1ZyUUpRV0ZMZlR3S056b01PV3NVaUNicElTRHN2QVFBQUFCUUFBQUFCQUFBQUF3QUFBQUVBQUFBQVF1NWtZOHprelNLS2hnSUpUMklwMnZMY2dqRUxNMXBnMVlpNDZDaXcxZDhBQUFBQlZWTkVRd0FBQUFCQ1BuMEY4dXl2dit3Wkt5RmFQeHZwYXUyNDJPY0NWS3ZqUVQ0Q0I5NVdzZ0FBQUFFQUFBQUFqa1J4OENGUzRHdnNibUw0Tldha1plVUNWdit2Mm1SVXlpNG5KV3ErQlhjQUFBQUJWVk5FUXdBQUFBQkNQbjBGOHV5dnYrd1pLeUZhUHh2cGF1MjQyT2NDVkt2alFUNENCOTVXc2dBQUFBWUFBQUFBQUFBQUFFTHVaR1BNNU0waWlvWUNDVTlpS2RyeTNJSXhDek5hWU5XSXVPZ29zTlhmQUFBQUZWOFk1UHZNbVBJWUFBQUFBQUFMNVRFQUFBRjRBQUFCTkFBQUFBQUFBNWNPQUFBQUFBPT0iLCJzaW11bGF0aW9uUmVzdWx0Ijp7ImF1dGgiOlsiQUFBQUFRQUFBQUFBQUFBQVF1NWtZOHprelNLS2hnSUpUMklwMnZMY2dqRUxNMXBnMVlpNDZDaXcxZDlmR09UN3pKanlHQUFBQUFBQUFBQUJBQUFBQUFBQUFBRlFSYzFld0hLYWRvL1ZyUUpRV0ZMZlR3S056b01PV3NVaUNicElTRHN2QVFBQUFBaDBjbUZ1YzJabGNnQUFBQU1BQUFBU0FBQUFBQUFBQUFCQzdtUmp6T1ROSW9xR0FnbFBZaW5hOHR5Q01Rc3pXbURWaUxqb0tMRFYzd0FBQUJJQUFBQUFBQUFBQUk1RWNmQWhVdUJyN0c1aStEVm1wR1hsQWxiL3I5cGtWTW91SnlWcXZnVjNBQUFBQ2dBQUFBQUFBQUFBQUFBQUFBQUFKeEFBQUFBQSJdLCJyZXR2YWwiOiJBQUFBQVE9PSJ9LCJzaW11bGF0aW9uVHJhbnNhY3Rpb25EYXRhIjoiQUFBQUFBQUFBQUlBQUFBQUFBQUFBRUx1WkdQTTVNMGlpb1lDQ1U5aUtkcnkzSUl4Q3pOYVlOV0l1T2dvc05YZkFBQUFCZ0FBQUFGUVJjMWV3SEthZG8vVnJRSlFXRkxmVHdLTnpvTU9Xc1VpQ2JwSVNEc3ZBUUFBQUJRQUFBQUJBQUFBQXdBQUFBRUFBQUFBUXU1a1k4emt6U0tLaGdJSlQySXAydkxjZ2pFTE0xcGcxWWk0NkNpdzFkOEFBQUFCVlZORVF3QUFBQUJDUG4wRjh1eXZ2K3daS3lGYVB4dnBhdTI0Mk9jQ1ZLdmpRVDRDQjk1V3NnQUFBQUVBQUFBQWprUng4Q0ZTNEd2c2JtTDROV2FrWmVVQ1Z2K3YybVJVeWk0bkpXcStCWGNBQUFBQlZWTkVRd0FBQUFCQ1BuMEY4dXl2dit3Wkt5RmFQeHZwYXUyNDJPY0NWS3ZqUVQ0Q0I5NVdzZ0FBQUFZQUFBQUFBQUFBQUVMdVpHUE01TTBpaW9ZQ0NVOWlLZHJ5M0lJeEN6TmFZTldJdU9nb3NOWGZBQUFBRlY4WTVQdk1tUElZQUFBQUFBQUw1VEVBQUFGNEFBQUJOQUFBQUFBQUE1Y08ifQ==";
  const txSignatureExpiration = 2345678;
  const { tx: baseTransactionXDR } = JSON.parse(
    Buffer.from(signedTxJson, "base64").toString("utf8"),
  );

  beforeAll(async () => {
    // Set up mocks
    vi.mocked(stellarUtils.getNetworkPassphrase).mockReturnValue(StellarNetworks.TESTNET);
    vi.mocked(stellarUtils.getRpcClient).mockReturnValue(mockServer);
    vi.mocked(mockServer.getLatestLedger).mockResolvedValue({
      sequence: txSignatureExpiration - 10,
    } as Api.GetLatestLedgerResponse);

    // Create valid requirements (V2 format)
    // Note: Values must match the transaction XDR from shared test
    validRequirements = {
      scheme: "exact",
      network: STELLAR_TESTNET_CAIP2,
      amount: "10000", // Extracted from transaction XDR
      payTo: TRANSACTION_RECIPIENT, // Must match transaction's recipient
      maxTimeoutSeconds: 60,
      asset: ASSET,
      extra: {
        maxLedgerOffset: 12,
      },
    };

    // Build full V2 PaymentPayload with mocked transaction
    validPayload = {
      x402Version: 2,
      resource: {
        url: "https://example.com/resource",
        description: "Test payment",
        mimeType: "application/json",
      },
      accepted: validRequirements,
      payload: {
        transaction: baseTransactionXDR,
      },
    };

    stellarPayload = validPayload.payload as { transaction: string };
    const txEnvelope = xdr.TransactionEnvelope.fromXDR(stellarPayload.transaction, "base64");
    baseTransaction = new Transaction(stellarPayload.transaction, networkPassphrase);
    baseSorobanData = txEnvelope.v1()?.tx()?.ext()?.sorobanData() || undefined;
    baseOperation = baseTransaction.operations[0] as Operation.InvokeHostFunction;
    baseFunc = baseOperation.func;
    baseInvokeContractArgs = baseFunc.invokeContract();
  });

  /**
   * Builds a modified transaction and wraps it in a PaymentPayload.
   */
  function buildStellarPayloadFromOp(
    operation: xdr.Operation,
    options?: { includeSorobanData?: boolean },
  ): PaymentPayload {
    const modifiedTx = new TransactionBuilder(account, {
      fee: baseTransaction.fee,
      networkPassphrase,
      ledgerbounds: baseTransaction.ledgerBounds,
      ...(options?.includeSorobanData !== false &&
        baseSorobanData && { sorobanData: baseSorobanData }),
    })
      .addOperation(operation)
      .setTimeout(validRequirements.maxTimeoutSeconds)
      .build();
    return {
      ...validPayload,
      payload: { transaction: modifiedTx.toXDR() },
    };
  }

  beforeEach(() => {
    // Random selection for 1-2 facilitators
    const useTwoFacilitators = Math.random() > 0.5;
    facilitatorSigners = useTwoFacilitators
      ? [facilitatorSigner1, facilitatorSigner2]
      : [facilitatorSigner1];

    // Use a high max fee for tests to avoid fee validation errors in tests that check other validations
    facilitator = new ExactStellarScheme(facilitatorSigners, {
      areFeesSponsored: true,
      maxTransactionFeeStroops: 1_000_000,
    });

    const expectedAssetHash = new Address(ASSET).toScAddress().contractId();
    const defaultTransferEvent = createMockContractEvent({
      from: CLIENT_PUBLIC,
      to: TRANSACTION_RECIPIENT,
      amount: BigInt(validRequirements.amount),
      contractId: expectedAssetHash,
    });

    vi.mocked(mockServer.simulateTransaction).mockResolvedValue({
      id: "test",
      latestLedger: 123,
      events: [defaultTransferEvent],
      _parsed: true,
      transactionData: new SorobanDataBuilder(),
      minResourceFee: "100",
      cost: { cpuInsns: "0", memBytes: "0" },
      results: [],
    } as Api.SimulateTransactionSuccessResponse);
  });

  describe("validation errors", () => {
    it("should reject invalid x402 version, scheme, and network mismatch", async () => {
      let result = await facilitator.verify(
        { ...validPayload, x402Version: 9 }, // ❌ unsupported x402 version
        validRequirements,
      );
      expect(result).toEqual(invalidVerifyResponse("invalid_x402_version"));

      result = await facilitator.verify(
        {
          ...validPayload,
          accepted: { ...validPayload.accepted, scheme: "invalid" }, // ❌ wrong scheme
        },
        validRequirements,
      );
      expect(result).toEqual(invalidVerifyResponse("unsupported_scheme"));

      result = await facilitator.verify(
        {
          ...validPayload,
          accepted: { ...validPayload.accepted, network: "foo:bar" }, // ❌ wrong network
        },
        validRequirements,
      );
      expect(result).toEqual(invalidVerifyResponse("network_mismatch"));
    });

    it("should reject transactions with fees exceeding the maximum", async () => {
      const lowMaxFeeFacilitator = new ExactStellarScheme(facilitatorSigners, {
        areFeesSponsored: true,
        maxTransactionFeeStroops: 150,
      });

      vi.mocked(stellarUtils.getRpcClient).mockReturnValue(mockServer as rpc.Server);
      vi.mocked(stellarUtils.getNetworkPassphrase).mockReturnValue(StellarNetworks.TESTNET);

      const result = await lowMaxFeeFacilitator.verify(validPayload, validRequirements);
      expect(result).toEqual(
        invalidVerifyResponse(
          "invalid_exact_stellar_payload_fee_exceeds_maximum",
          CLIENT_PUBLIC,
          "simulation-derived fee 200 stroops exceeds ceiling 150 stroops",
        ),
      );
    });

    it("should count the configured inclusion fee against the maximum", async () => {
      const highInclusionFacilitator = new ExactStellarScheme(facilitatorSigners, {
        areFeesSponsored: true,
        maxTransactionFeeStroops: 1_000,
        inclusionFeeStroops: 950,
      });

      vi.mocked(stellarUtils.getRpcClient).mockReturnValue(mockServer as rpc.Server);
      vi.mocked(stellarUtils.getNetworkPassphrase).mockReturnValue(StellarNetworks.TESTNET);

      const result = await highInclusionFacilitator.verify(validPayload, validRequirements);
      expect(result).toEqual(
        invalidVerifyResponse(
          "invalid_exact_stellar_payload_fee_exceeds_maximum",
          CLIENT_PUBLIC,
          "simulation-derived fee 1050 stroops exceeds ceiling 1000 stroops",
        ),
      );
    });

    describe("mismatching networks", () => {
      it("should reject mismatching requirement<>payload networks", async () => {
        const requirements: PaymentRequirements = {
          ...validRequirements,
          network: "eip155:84532" as never, // ❌ requirements network != payload accepted
        };
        const result = await facilitator.verify(validPayload, requirements);
        expect(result).toEqual(invalidVerifyResponse("network_mismatch"));
      });

      it("should reject when network is not a Stellar network", async () => {
        const wrongNetwork = "eip155:84532" as never; // ❌ non-Stellar network
        const requirements: PaymentRequirements = {
          ...validRequirements,
          network: wrongNetwork,
        };
        const payload: PaymentPayload = {
          ...validPayload,
          accepted: { ...validPayload.accepted, network: wrongNetwork },
        };
        const result = await facilitator.verify(payload, requirements);
        expect(result).toEqual(invalidVerifyResponse("invalid_network"));
      });
    });

    it("should reject malformed transaction XDR", async () => {
      const payload = {
        ...validPayload,
        payload: { transaction: "AAAA" }, // ❌ Invalid XDR
      };
      const result = await facilitator.verify(payload, validRequirements);
      expect(result).toEqual(invalidVerifyResponse("invalid_exact_stellar_payload_malformed"));
    });

    it("should reject wrong operation count", async () => {
      expect(baseSorobanData).toBeDefined();

      const parsedOperation = Operation.invokeHostFunction(baseOperation);
      const modifiedTx = new TransactionBuilder(account, {
        fee: baseTransaction.fee,
        networkPassphrase,
        ledgerbounds: baseTransaction.ledgerBounds,
        sorobanData: baseSorobanData,
      })
        .addOperation(parsedOperation)
        .addOperation(parsedOperation) // ❌ Multiple operations are forbidden
        .setTimeout(validRequirements.maxTimeoutSeconds)
        .build();

      const modifiedStellarPayload: PaymentPayload = {
        ...validPayload,
        payload: { transaction: modifiedTx.toXDR() },
      };

      const result = await facilitator.verify(modifiedStellarPayload, validRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_stellar_payload_wrong_operation");
    });

    it("should reject wrong operation type", async () => {
      const paymentOp = Operation.payment({
        // ❌ operation of unsupported type (MUST be invokeHostFunction)
        destination: CLIENT_PUBLIC,
        asset: Asset.native(),
        amount: "1",
      });
      const modifiedStellarPayload = buildStellarPayloadFromOp(paymentOp, {
        includeSorobanData: false,
      });

      const result = await facilitator.verify(modifiedStellarPayload, validRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_stellar_payload_wrong_operation");
    });

    it("should reject wrong contract function name", async () => {
      const wrongFuncArgs = new xdr.InvokeContractArgs({
        contractAddress: baseInvokeContractArgs.contractAddress(),
        functionName: "mint", // ❌ function name MUST be "transfer"
        args: baseInvokeContractArgs.args(),
      });
      const modifiedFunc = xdr.HostFunction.hostFunctionTypeInvokeContract(wrongFuncArgs);
      const modifiedOperation = Operation.invokeHostFunction({
        ...baseOperation,
        func: modifiedFunc,
      });
      const modifiedStellarPayload = buildStellarPayloadFromOp(modifiedOperation);

      const result = await facilitator.verify(modifiedStellarPayload, validRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_stellar_payload_wrong_function_name");
    });

    it("should reject wrong asset, recipient, or amount", async () => {
      let result = await facilitator.verify(validPayload, {
        ...validRequirements,
        asset: "CDNVQW44C3HALYNVQ4SOBXY5EWYTGVYXX6JPESOLQDABJI5FC5LTRRUE", // ❌ wrong asset
      });
      expect(result.invalidReason).toBe("invalid_exact_stellar_payload_wrong_asset");

      result = await facilitator.verify(validPayload, {
        ...validRequirements,
        payTo: "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER", // ❌ wrong recipient
      });
      expect(result.invalidReason).toBe("invalid_exact_stellar_payload_wrong_recipient");
      expect(result.payer).toBe(CLIENT_PUBLIC);

      result = await facilitator.verify(validPayload, {
        ...validRequirements,
        amount: "10001", // ❌ wrong amount
      });
      expect(result.invalidReason).toBe("invalid_exact_stellar_payload_wrong_amount");
      expect(result.payer).toBe(CLIENT_PUBLIC);
    });

    describe("Authorization entries and facilitator safety", () => {
      it("should reject when facilitator is the payer (from address)", async () => {
        const facilitatorAddress = facilitatorSigner1.address;

        if (!baseSorobanData || !baseOperation.auth?.length) {
          throw new Error("Missing sorobanData or auth in test transaction");
        }

        const originalArgs = baseInvokeContractArgs.args();
        const facilitatorKeypair = Keypair.fromPublicKey(facilitatorAddress);
        const facilitatorScAddress = xdr.ScVal.scvAddress(
          xdr.ScAddress.scAddressTypeAccount(
            xdr.PublicKey.publicKeyTypeEd25519(facilitatorKeypair.rawPublicKey()),
          ),
        );

        const modifiedInvokeContractArgs = new xdr.InvokeContractArgs({
          contractAddress: baseInvokeContractArgs.contractAddress(),
          functionName: baseInvokeContractArgs.functionName(),
          args: [
            facilitatorScAddress, // ❌ facilitator CANNOT be the payer
            originalArgs[1],
            originalArgs[2],
          ],
        });
        const modifiedFunc = xdr.HostFunction.hostFunctionTypeInvokeContract(
          modifiedInvokeContractArgs,
        );
        const modifiedOperation = Operation.invokeHostFunction({
          ...baseOperation,
          func: modifiedFunc,
        });
        const modifiedStellarPayload = buildStellarPayloadFromOp(modifiedOperation);

        const result = await facilitator.verify(modifiedStellarPayload, validRequirements);
        expect(result.isValid).toBe(false);
        expect(result.invalidReason).toBe("invalid_exact_stellar_payload_facilitator_is_payer");
      });

      it("should reject when a configured feeBumpSigner is the payer (from address)", async () => {
        const feeBumpSigner = createEd25519Signer(
          "SCKTFQJ2ASXITWPDKJ2KMQB7WOBNFV23OOTT6ZVO6AXVNAA3IJ7TRZFP",
          STELLAR_TESTNET_CAIP2,
        );
        const facilitatorWithFeeBump = new ExactStellarScheme(facilitatorSigners, {
          areFeesSponsored: true,
          maxTransactionFeeStroops: 1_000_000,
          feeBumpSigner,
        });

        if (!baseSorobanData || !baseOperation.auth?.length) {
          throw new Error("Missing sorobanData or auth in test transaction");
        }

        const originalArgs = baseInvokeContractArgs.args();
        const feeBumpKeypair = Keypair.fromPublicKey(feeBumpSigner.address);
        const feeBumpScAddress = xdr.ScVal.scvAddress(
          xdr.ScAddress.scAddressTypeAccount(
            xdr.PublicKey.publicKeyTypeEd25519(feeBumpKeypair.rawPublicKey()),
          ),
        );

        const modifiedInvokeContractArgs = new xdr.InvokeContractArgs({
          contractAddress: baseInvokeContractArgs.contractAddress(),
          functionName: baseInvokeContractArgs.functionName(),
          args: [
            feeBumpScAddress, // ❌ feeBumpSigner is facilitator-controlled too and must not be the payer
            originalArgs[1],
            originalArgs[2],
          ],
        });
        const modifiedFunc = xdr.HostFunction.hostFunctionTypeInvokeContract(
          modifiedInvokeContractArgs,
        );
        const modifiedOperation = Operation.invokeHostFunction({
          ...baseOperation,
          func: modifiedFunc,
        });
        const modifiedStellarPayload = buildStellarPayloadFromOp(modifiedOperation);

        const result = await facilitatorWithFeeBump.verify(
          modifiedStellarPayload,
          validRequirements,
        );
        expect(result.isValid).toBe(false);
        expect(result.invalidReason).toBe("invalid_exact_stellar_payload_facilitator_is_payer");
      });

      it("should reject empty auth entries array", async () => {
        const modifiedOperation = Operation.invokeHostFunction({
          ...baseOperation,
          auth: [], // ❌ Empty auth array
        });
        const modifiedStellarPayload = buildStellarPayloadFromOp(modifiedOperation);

        const result = await facilitator.verify(modifiedStellarPayload, validRequirements);
        expect(result.isValid).toBe(false);
        expect(result.invalidReason).toBe("invalid_exact_stellar_payload_no_auth_entries");
      });

      it("should reject missing payer signature", async () => {
        if (!baseSorobanData || !baseOperation.auth || baseOperation.auth.length === 0) {
          throw new Error("Missing sorobanData or auth in test transaction");
        }

        const originalAuth = baseOperation.auth[0];
        const originalCreds = originalAuth.credentials().address();

        const unsignedCreds = new xdr.SorobanAddressCredentials({
          address: originalCreds.address(),
          nonce: originalCreds.nonce(),
          signatureExpirationLedger: originalCreds.signatureExpirationLedger(),
          signature: xdr.ScVal.scvVoid(), // ❌ payer signature is missing
        });

        const authWithoutSignature = new xdr.SorobanAuthorizationEntry({
          credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(unsignedCreds),
          rootInvocation: originalAuth.rootInvocation(),
        });

        const modifiedOperation = Operation.invokeHostFunction({
          ...baseOperation,
          auth: [authWithoutSignature],
        });
        const modifiedStellarPayload = buildStellarPayloadFromOp(modifiedOperation);

        const result = await facilitator.verify(modifiedStellarPayload, validRequirements);
        expect(result.isValid).toBe(false);
        expect(result.invalidReason).toBe("invalid_exact_stellar_payload_missing_payer_signature");
        expect(result.payer).toBe(CLIENT_PUBLIC);
      });

      it("should reject unexpected pending signatures", async () => {
        if (!baseSorobanData || !baseOperation.auth || baseOperation.auth.length === 0) {
          throw new Error("Missing sorobanData or auth in test transaction");
        }

        const originalAuth = baseOperation.auth[0];
        const originalCreds = originalAuth.credentials().address();

        const otherKeypair = Keypair.random();
        const otherAddressScVal = xdr.ScAddress.scAddressTypeAccount(
          xdr.PublicKey.publicKeyTypeEd25519(otherKeypair.rawPublicKey()),
        );

        const pendingCreds = new xdr.SorobanAddressCredentials({
          address: otherAddressScVal,
          nonce: originalCreds.nonce(),
          signatureExpirationLedger: originalCreds.signatureExpirationLedger(),
          signature: xdr.ScVal.scvVoid(),
        });

        const pendingAuth = new xdr.SorobanAuthorizationEntry({
          credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(pendingCreds),
          rootInvocation: originalAuth.rootInvocation(),
        });

        const modifiedOperation = Operation.invokeHostFunction({
          ...baseOperation,
          auth: [originalAuth, pendingAuth], // ❌ unexpected pending signature(s)
        });
        const modifiedStellarPayload = buildStellarPayloadFromOp(modifiedOperation);

        const result = await facilitator.verify(modifiedStellarPayload, validRequirements);
        expect(result.isValid).toBe(false);
        expect(result.invalidReason).toBe(
          "invalid_exact_stellar_payload_unexpected_pending_signatures",
        );
        expect(result.payer).toBe(CLIENT_PUBLIC);
      });

      it("should reject expiration ledger too far in the future", async () => {
        if (!baseSorobanData || !baseOperation.auth || baseOperation.auth.length === 0) {
          throw new Error("Missing sorobanData or auth in test transaction");
        }

        const originalAuth = baseOperation.auth[0];
        const originalCreds = originalAuth.credentials().address();
        const farFuture = (txSignatureExpiration + 10_000).toString();

        const farFutureCreds = new xdr.SorobanAddressCredentials({
          address: originalCreds.address(),
          nonce: originalCreds.nonce(),
          signatureExpirationLedger: Number(farFuture), // ❌ Signature expiration too far
          signature: originalCreds.signature(),
        });

        const authWithFarExpiration = new xdr.SorobanAuthorizationEntry({
          credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(farFutureCreds),
          rootInvocation: originalAuth.rootInvocation(),
        });

        const modifiedOperation = Operation.invokeHostFunction({
          ...baseOperation,
          auth: [authWithFarExpiration],
        });
        const modifiedStellarPayload = buildStellarPayloadFromOp(modifiedOperation);

        const result = await facilitator.verify(modifiedStellarPayload, validRequirements);
        expect(result.isValid).toBe(false);
        expect(result.invalidReason).toBe("invalid_exact_stellar_signature_expiration_too_far");
        expect(result.payer).toBe(CLIENT_PUBLIC);
      });

      describe("credential type validation", () => {
        it("should reject auth entries with non-sorobanCredentialsAddress credentials", async () => {
          if (!baseSorobanData) {
            throw new Error("Missing sorobanData in test transaction");
          }

          const sourceAccountAuth = xdr.SorobanAuthorizationEntry.fromXDR(
            xdr.SorobanAuthorizationEntry.toXDR(
              new xdr.SorobanAuthorizationEntry({
                credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), // ❌ not sorobanCredentialsAddress
                rootInvocation: baseOperation.auth![0].rootInvocation(),
              }),
            ),
          );

          const modifiedOperation = Operation.invokeHostFunction({
            ...baseOperation,
            auth: [sourceAccountAuth],
          });
          const modifiedStellarPayload = buildStellarPayloadFromOp(modifiedOperation);

          const result = await facilitator.verify(modifiedStellarPayload, validRequirements);
          expect(result.isValid).toBe(false);
          expect(result.invalidReason).toBe(
            "invalid_exact_stellar_payload_unsupported_credential_type",
          );
        });

        it("should accept CAP-71 V2 address credentials signed over the V2 preimage", async () => {
          if (!baseSorobanData || !baseOperation.auth || baseOperation.auth.length === 0) {
            throw new Error("Missing sorobanData or auth in test transaction");
          }

          // Protocol 28 activates the V2 arm, so clients can submit V2-signed
          // entries and the facilitator must accept them alongside legacy V1.
          // The entry is re-signed over the address-bound CAP-71 preimage rather
          // than relabelling the V1 fixture's signature, so the payload matches
          // what an upgraded network actually accepts.
          const originalAuth = baseOperation.auth[0];
          const originalCredentials = originalAuth.credentials().address();
          const expirationLedger = originalCredentials.signatureExpirationLedger();

          const unsignedV2Auth = new xdr.SorobanAuthorizationEntry({
            credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(
              new xdr.SorobanAddressCredentials({
                address: originalCredentials.address(),
                nonce: originalCredentials.nonce(),
                signatureExpirationLedger: 0, // replaced by authorizeEntry
                signature: xdr.ScVal.scvVoid(),
              }),
            ),
            rootInvocation: originalAuth.rootInvocation(),
          });
          const v2Auth = await authorizeEntry(
            unsignedV2Auth,
            Keypair.fromSecret(CLIENT_SECRET),
            expirationLedger,
            networkPassphrase,
          );

          // The signature must commit to the CAP-71 address-bound preimage
          const v2Preimage = buildAuthorizationEntryPreimage(
            v2Auth,
            expirationLedger,
            networkPassphrase,
          );
          expect(v2Preimage.switch().name).toBe("envelopeTypeSorobanAuthorizationWithAddress");

          const modifiedOperation = Operation.invokeHostFunction({
            ...baseOperation,
            auth: [v2Auth],
          });
          const modifiedStellarPayload = buildStellarPayloadFromOp(modifiedOperation);

          const result = await facilitator.verify(modifiedStellarPayload, validRequirements);
          expect(result).toEqual(validVerifyResponse(CLIENT_PUBLIC));
        });

        it("should reject an unsigned V2 entry as a missing payer signature", async () => {
          if (!baseSorobanData || !baseOperation.auth || baseOperation.auth.length === 0) {
            throw new Error("Missing sorobanData or auth in test transaction");
          }

          const originalAuth = baseOperation.auth[0];
          const originalCredentials = originalAuth.credentials().address();

          const unsignedV2Auth = new xdr.SorobanAuthorizationEntry({
            credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(
              new xdr.SorobanAddressCredentials({
                address: originalCredentials.address(),
                nonce: originalCredentials.nonce(),
                signatureExpirationLedger: originalCredentials.signatureExpirationLedger(),
                signature: xdr.ScVal.scvVoid(), // ❌ never signed
              }),
            ),
            rootInvocation: originalAuth.rootInvocation(),
          });

          const modifiedOperation = Operation.invokeHostFunction({
            ...baseOperation,
            auth: [unsignedV2Auth],
          });
          const modifiedStellarPayload = buildStellarPayloadFromOp(modifiedOperation);

          const result = await facilitator.verify(modifiedStellarPayload, validRequirements);
          expect(result.isValid).toBe(false);
          expect(result.invalidReason).toBe(
            "invalid_exact_stellar_payload_missing_payer_signature",
          );
        });

        it("should reject delegated (addressWithDelegates) credentials", async () => {
          if (!baseSorobanData || !baseOperation.auth || baseOperation.auth.length === 0) {
            throw new Error("Missing sorobanData or auth in test transaction");
          }

          const originalAuth = baseOperation.auth[0];
          const delegatedAuth = new xdr.SorobanAuthorizationEntry({
            credentials: xdr.SorobanCredentials.sorobanCredentialsAddressWithDelegates(
              new xdr.SorobanAddressCredentialsWithDelegates({
                addressCredentials: originalAuth.credentials().address(),
                delegates: [],
              }),
            ),
            rootInvocation: originalAuth.rootInvocation(),
          });

          const modifiedOperation = Operation.invokeHostFunction({
            ...baseOperation,
            auth: [delegatedAuth],
          });
          const modifiedStellarPayload = buildStellarPayloadFromOp(modifiedOperation);

          const result = await facilitator.verify(modifiedStellarPayload, validRequirements);
          expect(result.isValid).toBe(false);
          expect(result.invalidReason).toBe(
            "invalid_exact_stellar_payload_unsupported_credential_type",
          );
        });
      });

      describe("sub-invocation validation", () => {
        it("should reject auth entries with sub-invocations", async () => {
          if (!baseSorobanData || !baseOperation.auth || baseOperation.auth.length === 0) {
            throw new Error("Missing sorobanData or auth in test transaction");
          }

          const originalAuth = baseOperation.auth[0];
          const originalRootInvocation = originalAuth.rootInvocation();

          const subInvocation = new xdr.SorobanAuthorizedInvocation({
            function: originalRootInvocation.function(),
            subInvocations: [],
          });

          const rootWithSubInvocations = new xdr.SorobanAuthorizedInvocation({
            function: originalRootInvocation.function(),
            subInvocations: [subInvocation], // ❌ sub-invocations not allowed
          });

          const authWithSubInvocations = new xdr.SorobanAuthorizationEntry({
            credentials: originalAuth.credentials(),
            rootInvocation: rootWithSubInvocations,
          });

          const modifiedOperation = Operation.invokeHostFunction({
            ...baseOperation,
            auth: [authWithSubInvocations],
          });
          const modifiedStellarPayload = buildStellarPayloadFromOp(modifiedOperation);

          const result = await facilitator.verify(modifiedStellarPayload, validRequirements);
          expect(result.isValid).toBe(false);
          expect(result.invalidReason).toBe("invalid_exact_stellar_payload_has_subinvocations");
        });
      });

      describe("facilitator in auth entries validation", () => {
        it("should reject when facilitator address is in auth entries", async () => {
          if (!baseSorobanData || !baseOperation.auth || baseOperation.auth.length === 0) {
            throw new Error("Missing sorobanData or auth in test transaction");
          }

          const facilitatorAddress = facilitatorSigner1.address;
          const originalAuth = baseOperation.auth[0];
          const originalAddressCredentials = originalAuth.credentials().address();

          const facilitatorKeypair = Keypair.fromPublicKey(facilitatorAddress);
          const facilitatorAddressScVal = xdr.ScAddress.scAddressTypeAccount(
            xdr.PublicKey.publicKeyTypeEd25519(facilitatorKeypair.rawPublicKey()),
          );

          const facilitatorCredentials = new xdr.SorobanAddressCredentials({
            address: facilitatorAddressScVal, // ❌ facilitator address in auth entry
            nonce: originalAddressCredentials.nonce(),
            signatureExpirationLedger: originalAddressCredentials.signatureExpirationLedger(),
            signature: originalAddressCredentials.signature(),
          });

          const authWithFacilitator = new xdr.SorobanAuthorizationEntry({
            credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(facilitatorCredentials),
            rootInvocation: originalAuth.rootInvocation(),
          });

          const modifiedOperation = Operation.invokeHostFunction({
            ...baseOperation,
            auth: [authWithFacilitator],
          });
          const modifiedStellarPayload = buildStellarPayloadFromOp(modifiedOperation);

          const result = await facilitator.verify(modifiedStellarPayload, validRequirements);
          expect(result.isValid).toBe(false);
          expect(result.invalidReason).toBe("invalid_exact_stellar_payload_facilitator_in_auth");
        });
      });

      describe("should reject when source is unauthorized", () => {
        it("should reject operation.source == facilitatorAccount", async () => {
          const facilitatorAddress = facilitatorSigner1.address;

          if (!baseSorobanData) {
            throw new Error("Missing sorobanData in test transaction");
          }

          const modifiedOperation = Operation.invokeHostFunction({
            ...baseOperation,
            source: facilitatorAddress, // ❌ operation source is facilitator
          });
          const modifiedStellarPayload = buildStellarPayloadFromOp(modifiedOperation);

          const result = await facilitator.verify(modifiedStellarPayload, validRequirements);
          expect(result.isValid).toBe(false);
          expect(result.invalidReason).toBe("invalid_exact_stellar_payload_unsafe_tx_or_op_source");
        });

        it("should reject transaction.source == facilitatorAccount", async () => {
          const facilitatorAddress = facilitatorSigner1.address;

          if (!baseSorobanData) {
            throw new Error("Missing sorobanData in test transaction");
          }

          const modifiedOperation = Operation.invokeHostFunction({
            ...baseOperation,
          });
          const facilitatorAccount = new Account(facilitatorAddress, "100"); // ❌ transaction source is facilitator
          const modifiedTx = new TransactionBuilder(facilitatorAccount, {
            fee: baseTransaction.fee,
            networkPassphrase,
            ledgerbounds: baseTransaction.ledgerBounds,
            sorobanData: baseSorobanData,
          })
            .addOperation(modifiedOperation)
            .setTimeout(validRequirements.maxTimeoutSeconds)
            .build();

          const modifiedStellarPayload: PaymentPayload = {
            ...validPayload,
            payload: {
              transaction: modifiedTx.toXDR(),
            },
          };

          const result = await facilitator.verify(modifiedStellarPayload, validRequirements);
          expect(result.isValid).toBe(false);
          expect(result.invalidReason).toBe("invalid_exact_stellar_payload_unsafe_tx_or_op_source");
        });
      });
    });

    it("should reject simulation failure", async () => {
      vi.mocked(mockServer.simulateTransaction).mockResolvedValueOnce({
        error: "Simulation failed", // ❌ Simulation error
        events: [],
        id: "test",
        latestLedger: 123,
        _parsed: true,
      } as Api.SimulateTransactionErrorResponse);

      const result = await facilitator.verify(validPayload, validRequirements);
      expect(result.invalidReason).toBe("invalid_exact_stellar_payload_simulation_failed");
      expect(result.payer).toBe(CLIENT_PUBLIC);
    });

    // Event-based balance change validation
    describe("simulation event validation", () => {
      const expectedAssetHash = () => new Address(ASSET).toScAddress().contractId();

      it("should reject when simulation shows multiple transfer events", async () => {
        const mockTransferEvent1 = createMockContractEvent({
          from: CLIENT_PUBLIC,
          to: TRANSACTION_RECIPIENT,
          amount: BigInt(10000),
          contractId: expectedAssetHash(),
        });
        const mockTransferEvent2 = createMockContractEvent({
          from: CLIENT_PUBLIC,
          to: "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER",
          amount: BigInt(5000),
          contractId: expectedAssetHash(),
        });

        vi.mocked(mockServer.simulateTransaction).mockResolvedValueOnce({
          id: "test",
          latestLedger: 123,
          events: [mockTransferEvent1, mockTransferEvent2], // ❌ multiple transfer events
          _parsed: true,
          transactionData: new SorobanDataBuilder(),
          minResourceFee: "100",
          cost: { cpuInsns: "0", memBytes: "0" },
          results: [],
        } as Api.SimulateTransactionSuccessResponse);

        const result = await facilitator.verify(validPayload, validRequirements);
        expect(result.isValid).toBe(false);
        expect(result.invalidReason).toBe("invalid_exact_stellar_payload_multiple_transfers");
      });

      it("should reject when transfer event has wrong from address", async () => {
        const mockTransferEvent = createMockContractEvent({
          from: "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER", // ❌ wrong `from` address
          to: FACILITATOR_PUBLIC,
          amount: BigInt(10000),
          contractId: expectedAssetHash(),
        });

        vi.mocked(mockServer.simulateTransaction).mockResolvedValueOnce({
          id: "test",
          latestLedger: 123,
          events: [mockTransferEvent],
          _parsed: true,
          transactionData: new SorobanDataBuilder(),
          minResourceFee: "100",
          cost: { cpuInsns: "0", memBytes: "0" },
          results: [],
        } as Api.SimulateTransactionSuccessResponse);

        const result = await facilitator.verify(validPayload, validRequirements);
        expect(result.isValid).toBe(false);
        expect(result.invalidReason).toBe("invalid_exact_stellar_payload_event_wrong_from");
      });

      it("should reject when transfer event has wrong to address", async () => {
        const mockTransferEvent = createMockContractEvent({
          from: CLIENT_PUBLIC,
          to: "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER", // ❌ wrong `to` address
          amount: BigInt(10000),
          contractId: expectedAssetHash(),
        });

        vi.mocked(mockServer.simulateTransaction).mockResolvedValueOnce({
          id: "test",
          latestLedger: 123,
          events: [mockTransferEvent],
          _parsed: true,
          transactionData: new SorobanDataBuilder(),
          minResourceFee: "100",
          cost: { cpuInsns: "0", memBytes: "0" },
          results: [],
        } as Api.SimulateTransactionSuccessResponse);

        const result = await facilitator.verify(validPayload, validRequirements);
        expect(result.isValid).toBe(false);
        expect(result.invalidReason).toBe("invalid_exact_stellar_payload_event_wrong_to");
      });

      it("should reject when transfer event has wrong amount", async () => {
        const mockTransferEvent = createMockContractEvent({
          from: CLIENT_PUBLIC,
          to: TRANSACTION_RECIPIENT,
          amount: BigInt(5000), // ❌ wrong `amount` (expected 10000)
          contractId: expectedAssetHash(),
        });

        vi.mocked(mockServer.simulateTransaction).mockResolvedValueOnce({
          id: "test",
          latestLedger: 123,
          events: [mockTransferEvent],
          _parsed: true,
          transactionData: new SorobanDataBuilder(),
          minResourceFee: "100",
          cost: { cpuInsns: "0", memBytes: "0" },
          results: [],
        } as Api.SimulateTransactionSuccessResponse);

        const result = await facilitator.verify(validPayload, validRequirements);
        expect(result.isValid).toBe(false);
        expect(result.invalidReason).toBe("invalid_exact_stellar_payload_event_wrong_amount");
      });

      it("should reject when transfer event has null contractId", async () => {
        const mockTransferEvent = createMockContractEvent({
          from: CLIENT_PUBLIC,
          to: TRANSACTION_RECIPIENT,
          amount: BigInt(10000),
          contractId: null,
        });

        vi.mocked(mockServer.simulateTransaction).mockResolvedValueOnce({
          id: "test",
          latestLedger: 123,
          events: [mockTransferEvent],
          _parsed: true,
          transactionData: new SorobanDataBuilder(),
          minResourceFee: "100",
          cost: { cpuInsns: "0", memBytes: "0" },
          results: [],
        } as Api.SimulateTransactionSuccessResponse);

        const result = await facilitator.verify(validPayload, validRequirements);
        expect(result.isValid).toBe(false);
        expect(result.invalidReason).toBe(
          "invalid_exact_stellar_payload_event_missing_contract_id",
        );
      });

      it("should reject when transfer event has wrong asset (contract address)", async () => {
        const wrongAsset = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
        const mockTransferEvent = createMockContractEvent({
          from: CLIENT_PUBLIC,
          to: TRANSACTION_RECIPIENT,
          amount: BigInt(10000),
          contractId: new Address(wrongAsset).toScAddress().contractId(),
        });

        vi.mocked(mockServer.simulateTransaction).mockResolvedValueOnce({
          id: "test",
          latestLedger: 123,
          events: [mockTransferEvent],
          _parsed: true,
          transactionData: new SorobanDataBuilder(),
          minResourceFee: "100",
          cost: { cpuInsns: "0", memBytes: "0" },
          results: [],
        } as Api.SimulateTransactionSuccessResponse);

        const result = await facilitator.verify(validPayload, validRequirements);
        expect(result.isValid).toBe(false);
        expect(result.invalidReason).toBe("invalid_exact_stellar_payload_event_wrong_asset");
      });

      it("should reject when no transfer events are present", async () => {
        vi.mocked(mockServer.simulateTransaction).mockResolvedValueOnce({
          id: "test",
          latestLedger: 123,
          events: [], // ❌ no transfer events
          _parsed: true,
          transactionData: new SorobanDataBuilder(),
          minResourceFee: "100",
          cost: { cpuInsns: "0", memBytes: "0" },
          results: [],
        } as Api.SimulateTransactionSuccessResponse);

        const result = await facilitator.verify(validPayload, validRequirements);
        expect(result.isValid).toBe(false);
        expect(result.invalidReason).toBe("invalid_exact_stellar_payload_no_transfer_events");
      });

      it("should reject when a contract event is not a transfer", async () => {
        const mockNonTransferEvent = createMockContractEvent({
          from: CLIENT_PUBLIC,
          to: FACILITATOR_PUBLIC,
          amount: BigInt(10000),
          fnName: "mint", // ❌ event is not "transfer"
        });

        vi.mocked(mockServer.simulateTransaction).mockResolvedValueOnce({
          id: "test",
          latestLedger: 123,
          events: [mockNonTransferEvent],
          _parsed: true,
          transactionData: new SorobanDataBuilder(),
          minResourceFee: "100",
          cost: { cpuInsns: "0", memBytes: "0" },
          results: [],
        } as Api.SimulateTransactionSuccessResponse);

        const result = await facilitator.verify(validPayload, validRequirements);
        expect(result.isValid).toBe(false);
        expect(result.invalidReason).toBe("invalid_exact_stellar_payload_event_not_transfer");
      });

      it("should ignore non-contract events and still accept valid transfer", async () => {
        const mockTransferEvent = createMockContractEvent({
          from: CLIENT_PUBLIC,
          to: TRANSACTION_RECIPIENT,
          amount: BigInt(10000),
          contractId: expectedAssetHash(),
        });
        const nonContractEvent = createMockSystemEvent();

        vi.mocked(mockServer.simulateTransaction).mockResolvedValueOnce({
          id: "test",
          latestLedger: 123,
          events: [nonContractEvent, mockTransferEvent],
          _parsed: true,
          transactionData: new SorobanDataBuilder(),
          minResourceFee: "100",
          cost: { cpuInsns: "0", memBytes: "0" },
          results: [],
        } as Api.SimulateTransactionSuccessResponse);

        const result = await facilitator.verify(validPayload, validRequirements);
        expect(result.isValid).toBe(true);
      });
    });
  });

  describe("🎉 Successful verification", () => {
    it("should verify valid payment", async () => {
      const result = await facilitator.verify(validPayload, validRequirements);
      expect(result).toEqual(validVerifyResponse(CLIENT_PUBLIC));
      expect(stellarUtils.getRpcClient).toHaveBeenCalledWith(STELLAR_TESTNET_CAIP2, undefined);
      expect(mockServer.simulateTransaction).toHaveBeenCalled();
    });
  });

  describe("OpenZeppelin spending_limit_enforced on the public verify path", () => {
    const NON_ASSET_CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const MALFORMED = "invalid_exact_stellar_payload_malformed_policy_event";
    const CONTRADICTORY = "invalid_exact_stellar_payload_contradictory_authorization";
    const NOT_TRANSFER = "invalid_exact_stellar_payload_event_not_transfer";
    const WRONG_ASSET = "invalid_exact_stellar_payload_event_wrong_asset";
    const NO_TRANSFER = "invalid_exact_stellar_payload_no_transfer_events";
    const MULTIPLE = "invalid_exact_stellar_payload_multiple_transfers";
    const WRONG_TO = "invalid_exact_stellar_payload_event_wrong_to";
    const policyContractId = () => new Address(NON_ASSET_CONTRACT).toScAddress().contractId();
    const assetContractId = () => new Address(ASSET).toScAddress().contractId();

    function assetTransfer(): xdr.DiagnosticEvent {
      return createMockContractEvent({
        from: CLIENT_PUBLIC,
        to: TRANSACTION_RECIPIENT,
        amount: 10_000n,
        contractId: assetContractId(),
      });
    }

    function balanceChangingEvent(fnName: string): xdr.DiagnosticEvent {
      return createMockContractEvent({
        from: CLIENT_PUBLIC,
        to: TRANSACTION_RECIPIENT,
        amount: 10_000n,
        fnName,
        contractId: policyContractId(),
      });
    }

    function contractContext(params?: {
      asset?: string;
      from?: string;
      to?: string;
      amount?: bigint;
      fnName?: string;
      variant?: string;
      argCount?: number;
    }): xdr.ScVal {
      const amount = params?.amount ?? 10_000n;
      const args = [
        addressScVal(params?.from ?? CLIENT_PUBLIC),
        addressScVal(params?.to ?? TRANSACTION_RECIPIENT),
        i128ScVal(amount),
      ];
      const argCount = params?.argCount ?? 3;
      if (argCount < 3) args.pop();
      if (argCount > 3) args.push(xdr.ScVal.scvU32(1));
      return xdr.ScVal.scvVec([
        symbolScVal(params?.variant ?? "Contract"),
        symbolMap([
          ["args", xdr.ScVal.scvVec(args)],
          ["contract", addressScVal(params?.asset ?? ASSET)],
          ["fn_name", symbolScVal(params?.fnName ?? "transfer")],
        ]),
      ]);
    }

    function spendingLimitEvent(options?: {
      encoding?: "map" | "vec";
      smartAccount?: string;
      accountTopic?: xdr.ScVal;
      contractId?: xdr.Hash | null;
      amount?: bigint;
      total?: bigint;
      context?: xdr.ScVal;
      amountVal?: xdr.ScVal;
      totalVal?: xdr.ScVal;
      ruleVal?: xdr.ScVal;
      data?: xdr.ScVal;
      symbol?: string;
      omitAccount?: boolean;
      extraTopic?: boolean;
      extraMapEntry?: boolean;
      omitTotal?: boolean;
    }): xdr.DiagnosticEvent {
      const amount = options?.amount ?? 10_000n;
      const total = options?.total ?? amount;
      const context = options?.context ?? contractContext();
      const amountVal = options?.amountVal ?? i128ScVal(amount);
      const totalVal = options?.totalVal ?? i128ScVal(total);
      const ruleVal = options?.ruleVal ?? xdr.ScVal.scvU32(1);
      let data = options?.data;
      if (!data) {
        if (options?.encoding === "vec") {
          data = xdr.ScVal.scvVec([context, ruleVal, amountVal, totalVal]);
        } else {
          const entries: Array<[string, xdr.ScVal]> = [
            ["amount", amountVal],
            ["context", context],
            ["context_rule_id", ruleVal],
          ];
          if (!options?.omitTotal) entries.push(["total_spent_in_period", totalVal]);
          if (options?.extraMapEntry) entries.push(["note", symbolScVal("note")]);
          data = symbolMap(entries);
        }
      }
      const topics = [symbolScVal(options?.symbol ?? "spending_limit_enforced")];
      if (!options?.omitAccount) {
        topics.push(options?.accountTopic ?? addressScVal(options?.smartAccount ?? CLIENT_PUBLIC));
      }
      if (options?.extraTopic) topics.push(symbolScVal("extra"));
      return createMockDiagnosticEvent(
        new xdr.ContractEventV0({ topics, data }),
        xdr.ContractEventType.contract(),
        options?.contractId === undefined ? policyContractId() : options.contractId,
      );
    }

    function mockSimulation(events: xdr.DiagnosticEvent[], minResourceFee = "100"): void {
      vi.mocked(mockServer.simulateTransaction).mockResolvedValueOnce({
        id: "cold-replay",
        latestLedger: 123,
        events,
        _parsed: true,
        transactionData: new SorobanDataBuilder(),
        minResourceFee,
        cost: { cpuInsns: "0", memBytes: "0" },
        results: [],
      } as Api.SimulateTransactionSuccessResponse);
    }

    const observedResourceFee = "290000";
    const derivedFee = 290_100;

    it("accepts the soroban-sdk 26.1.0 map event when the caller raises the fee ceiling", async () => {
      const scheme = new ExactStellarScheme(facilitatorSigners, {
        maxTransactionFeeStroops: derivedFee,
      });
      const events = [spendingLimitEvent({ encoding: "map", total: 25_000n }), assetTransfer()];
      vi.mocked(mockServer.simulateTransaction).mockClear();
      mockSimulation(events, observedResourceFee);

      const result = await scheme.verify(validPayload, validRequirements);

      expect(result).toEqual(validVerifyResponse(CLIENT_PUBLIC));
      expect(scheme.maxTransactionFeeStroops).toBe(derivedFee);
      expect(scheme.rpcConfig).toBeUndefined();
      expect(stellarUtils.getRpcClient).toHaveBeenCalledWith(STELLAR_TESTNET_CAIP2, undefined);
      const simulated = vi.mocked(mockServer.simulateTransaction).mock.calls.at(-1)?.[0];
      expect(simulated).toBeInstanceOf(Transaction);
      expect((simulated as Transaction).toXDR()).toBe(
        (validPayload.payload as { transaction: string }).transaction,
      );
    });

    it("accepts the documented four-value list after the asset transfer", async () => {
      const scheme = new ExactStellarScheme(facilitatorSigners, {
        maxTransactionFeeStroops: derivedFee,
      });
      mockSimulation(
        [assetTransfer(), spendingLimitEvent({ encoding: "vec" })],
        observedResourceFee,
      );

      const result = await scheme.verify(validPayload, validRequirements);
      expect(result).toEqual(validVerifyResponse(CLIENT_PUBLIC));
    });

    it("refuses the same smart-account simulation at the unchanged 50000 default", async () => {
      const scheme = new ExactStellarScheme(facilitatorSigners);
      mockSimulation(
        [spendingLimitEvent({ encoding: "map" }), assetTransfer()],
        observedResourceFee,
      );

      const result = await scheme.verify(validPayload, validRequirements);
      expect(scheme.maxTransactionFeeStroops).toBe(50_000);
      expect(result).toEqual(
        invalidVerifyResponse(
          "invalid_exact_stellar_payload_fee_exceeds_maximum",
          CLIENT_PUBLIC,
          `simulation-derived fee ${derivedFee} stroops exceeds ceiling 50000 stroops`,
        ),
      );
    });

    it("refuses an explicit ceiling that is still below the derived fee", async () => {
      const scheme = new ExactStellarScheme(facilitatorSigners, {
        maxTransactionFeeStroops: derivedFee - 1,
      });
      mockSimulation(
        [spendingLimitEvent({ encoding: "map" }), assetTransfer()],
        observedResourceFee,
      );

      const result = await scheme.verify(validPayload, validRequirements);
      expect(result).toEqual(
        invalidVerifyResponse(
          "invalid_exact_stellar_payload_fee_exceeds_maximum",
          CLIENT_PUBLIC,
          `simulation-derived fee ${derivedFee} stroops exceeds ceiling ${derivedFee - 1} stroops`,
        ),
      );
    });

    it("keeps the default ceiling for an ordinary transfer under 50000 stroops", async () => {
      const scheme = new ExactStellarScheme(facilitatorSigners);
      mockSimulation([assetTransfer()], "100");

      const result = await scheme.verify(validPayload, validRequirements);
      expect(scheme.maxTransactionFeeStroops).toBe(50_000);
      expect(result).toEqual(validVerifyResponse(CLIENT_PUBLIC));
    });

    const adversarial: Array<[string, () => xdr.DiagnosticEvent[], string]> = [
      ["a policy event with no asset transfer", () => [spendingLimitEvent()], NO_TRANSFER],
      [
        "a second spending_limit_enforced event",
        () => [spendingLimitEvent(), spendingLimitEvent(), assetTransfer()],
        CONTRADICTORY,
      ],
      [
        "a smart account topic that is not the payer",
        () => [spendingLimitEvent({ smartAccount: FACILITATOR_PUBLIC }), assetTransfer()],
        CONTRADICTORY,
      ],
      [
        "a policy amount that disagrees with the transfer",
        () => [spendingLimitEvent({ amount: 5_000n }), assetTransfer()],
        CONTRADICTORY,
      ],
      [
        "a period total below the spent amount",
        () => [spendingLimitEvent({ amount: 10_000n, total: 9_999n }), assetTransfer()],
        CONTRADICTORY,
      ],
      [
        "a context payee that disagrees with the transfer",
        () => [
          spendingLimitEvent({ context: contractContext({ to: FACILITATOR_PUBLIC }) }),
          assetTransfer(),
        ],
        CONTRADICTORY,
      ],
      [
        "a context asset that disagrees with the transfer",
        () => [
          spendingLimitEvent({ context: contractContext({ asset: NON_ASSET_CONTRACT }) }),
          assetTransfer(),
        ],
        CONTRADICTORY,
      ],
      [
        "a context function other than transfer",
        () => [
          spendingLimitEvent({ context: contractContext({ fnName: "approve" }) }),
          assetTransfer(),
        ],
        CONTRADICTORY,
      ],
      [
        "a non-contract authorization context",
        () => [
          spendingLimitEvent({
            context: contractContext({ variant: "CreateContractHostFn" }),
          }),
          assetTransfer(),
        ],
        CONTRADICTORY,
      ],
      [
        "a transfer context with extra arguments",
        () => [spendingLimitEvent({ context: contractContext({ argCount: 4 }) }), assetTransfer()],
        CONTRADICTORY,
      ],
      [
        "a policy event with no publishing contract id",
        () => [spendingLimitEvent({ contractId: null }), assetTransfer()],
        MALFORMED,
      ],
      [
        "a policy event with one topic",
        () => [spendingLimitEvent({ omitAccount: true }), assetTransfer()],
        MALFORMED,
      ],
      [
        "a policy event with an extra topic",
        () => [spendingLimitEvent({ extraTopic: true }), assetTransfer()],
        MALFORMED,
      ],
      [
        "a smart account topic that is not an address",
        () => [spendingLimitEvent({ accountTopic: symbolScVal("account") }), assetTransfer()],
        MALFORMED,
      ],
      [
        "a policy amount that is not i128",
        () => [spendingLimitEvent({ amountVal: xdr.ScVal.scvU32(10_000) }), assetTransfer()],
        MALFORMED,
      ],
      [
        "a context rule id that is not u32",
        () => [spendingLimitEvent({ ruleVal: xdr.ScVal.scvI32(1) }), assetTransfer()],
        MALFORMED,
      ],
      [
        "a period total that is not i128",
        () => [spendingLimitEvent({ totalVal: xdr.ScVal.scvU32(10_000) }), assetTransfer()],
        MALFORMED,
      ],
      [
        "policy data that is not the map or the documented list",
        () => [spendingLimitEvent({ data: xdr.ScVal.scvVoid() }), assetTransfer()],
        MALFORMED,
      ],
      [
        "a policy map with an extra field",
        () => [spendingLimitEvent({ extraMapEntry: true }), assetTransfer()],
        MALFORMED,
      ],
      [
        "a policy map missing total_spent_in_period",
        () => [spendingLimitEvent({ omitTotal: true }), assetTransfer()],
        MALFORMED,
      ],
      [
        "a documented list in the wrong order",
        () => [
          spendingLimitEvent({
            data: xdr.ScVal.scvVec([
              i128ScVal(10_000n),
              contractContext(),
              xdr.ScVal.scvU32(1),
              i128ScVal(10_000n),
            ]),
          }),
          assetTransfer(),
        ],
        MALFORMED,
      ],
      [
        "spending_limit_installed beside a valid transfer",
        () => [spendingLimitEvent({ symbol: "spending_limit_installed" }), assetTransfer()],
        NOT_TRANSFER,
      ],
      [
        "spending_limit_changed beside a valid transfer",
        () => [spendingLimitEvent({ symbol: "spending_limit_changed" }), assetTransfer()],
        NOT_TRANSFER,
      ],
      [
        "spending_limit_uninstalled beside a valid transfer",
        () => [spendingLimitEvent({ symbol: "spending_limit_uninstalled" }), assetTransfer()],
        NOT_TRANSFER,
      ],
      [
        "an unknown non-asset symbol beside a valid transfer",
        () => [spendingLimitEvent({ symbol: "custom_hook" }), assetTransfer()],
        NOT_TRANSFER,
      ],
      [
        "mint from a non-asset contract beside a valid transfer",
        () => [balanceChangingEvent("mint"), assetTransfer()],
        NOT_TRANSFER,
      ],
      [
        "burn from a non-asset contract beside a valid transfer",
        () => [balanceChangingEvent("burn"), assetTransfer()],
        NOT_TRANSFER,
      ],
      [
        "clawback from a non-asset contract beside a valid transfer",
        () => [balanceChangingEvent("clawback"), assetTransfer()],
        NOT_TRANSFER,
      ],
      [
        "an extra transfer from a non-asset contract",
        () => [balanceChangingEvent("transfer"), assetTransfer()],
        WRONG_ASSET,
      ],
      [
        "spending_limit_enforced published by the asset contract",
        () => [spendingLimitEvent({ contractId: assetContractId() }), assetTransfer()],
        NOT_TRANSFER,
      ],
      [
        "two asset transfers plus a matching policy event",
        () => [spendingLimitEvent(), assetTransfer(), assetTransfer()],
        MULTIPLE,
      ],
      [
        "a matching policy event with the wrong transfer payee",
        () => [
          spendingLimitEvent(),
          createMockContractEvent({
            from: CLIENT_PUBLIC,
            to: FACILITATOR_PUBLIC,
            amount: 10_000n,
            contractId: assetContractId(),
          }),
        ],
        WRONG_TO,
      ],
    ];

    it.each(adversarial)("rejects %s", async (_label, buildEvents, reason) => {
      mockSimulation(buildEvents());
      const result = await facilitator.verify(validPayload, validRequirements);
      expect(result).toEqual(invalidVerifyResponse(reason, CLIENT_PUBLIC));
    });
  });

  describe("public contract-payer envelope from issue 3764", () => {
    const PUBLIC_PAYER = "CDQSAMY2O6SCFRXA5SSZHAFT7SAZ7DYHLZVKCHH646KTEDFMBEWO4SFX";
    const PUBLIC_PAYEE = "GAKQLYQXVMZHTQSRHIKXJZCAOJHPOZYT3XZHRXBBD7X2QWGJ3TLJEYUA";
    const PUBLIC_ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
    const PUBLIC_POLICY = "CABXBYJNZ7IUW4G3D6BND5YCAQF3ASSDMDAOKQQ63UYFSO7WUU2TIP5G";
    const PUBLIC_LEDGER = 5120533;
    const INCLUSION_LEDGER_RESOURCE_FEE = "290000";
    const DERIVED_FEE = 290_100;
    const fixture = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "../fixtures/issue-3764-public-verify.json"),
        "utf8",
      ),
    ) as { envelopeXdr: string; diagnosticEventsXdr: string[] };

    function publicEvents(): xdr.DiagnosticEvent[] {
      return fixture.diagnosticEventsXdr.map(entry => xdr.DiagnosticEvent.fromXDR(entry, "base64"));
    }

    function publicRequirements(maxTimeoutSeconds: number): PaymentRequirements {
      return {
        ...validRequirements,
        amount: "10000000",
        payTo: PUBLIC_PAYEE,
        asset: PUBLIC_ASSET,
        maxTimeoutSeconds,
      };
    }

    function publicPayload(requirements: PaymentRequirements): PaymentPayload {
      return {
        ...validPayload,
        accepted: requirements,
        payload: { transaction: fixture.envelopeXdr },
      };
    }

    function mockPublicSimulation(minResourceFee: string, ledger?: number): void {
      if (ledger !== undefined) {
        vi.mocked(mockServer.getLatestLedger).mockResolvedValueOnce({
          sequence: ledger,
        } as Api.GetLatestLedgerResponse);
      }
      vi.mocked(mockServer.simulateTransaction).mockResolvedValueOnce({
        id: "issue-3764-public-verify",
        latestLedger: PUBLIC_LEDGER,
        events: publicEvents(),
        _parsed: true,
        transactionData: new SorobanDataBuilder(),
        minResourceFee,
        cost: { cpuInsns: "0", memBytes: "0" },
        results: [],
      } as Api.SimulateTransactionSuccessResponse);
    }

    afterEach(() => {
      vi.mocked(mockServer.getLatestLedger).mockReset();
      vi.mocked(mockServer.getLatestLedger).mockResolvedValue({
        sequence: txSignatureExpiration - 10,
      } as Api.GetLatestLedgerResponse);
    });

    it("verifies the contract payer when the caller ceiling is the derived fee", async () => {
      const events = publicEvents();
      const policy = events.find(diagnostic => {
        const event = diagnostic.event();
        if (event.type().name !== "contract") return false;
        const topic = event.body().v0().topics()[0];
        return (
          topic?.switch().name === "scvSymbol" &&
          topic.sym().toString() === "spending_limit_enforced"
        );
      });
      expect(policy).toBeDefined();
      const policyContract = Address.fromScAddress(
        xdr.ScAddress.scAddressTypeContract(policy!.event().contractId()!),
      ).toString();
      expect(policyContract).toBe(PUBLIC_POLICY);

      const scheme = new ExactStellarScheme(facilitatorSigners, {
        maxTransactionFeeStroops: DERIVED_FEE,
      });
      const requirements = publicRequirements(300);
      vi.mocked(mockServer.simulateTransaction).mockClear();
      mockPublicSimulation(INCLUSION_LEDGER_RESOURCE_FEE, PUBLIC_LEDGER);

      const result = await scheme.verify(publicPayload(requirements), requirements);

      expect(result).toEqual(validVerifyResponse(PUBLIC_PAYER));
      expect(scheme.maxTransactionFeeStroops).toBe(DERIVED_FEE);
      expect(scheme.rpcConfig).toBeUndefined();
      expect(stellarUtils.getRpcClient).toHaveBeenCalledWith(STELLAR_TESTNET_CAIP2, undefined);
      const simulated = vi.mocked(mockServer.simulateTransaction).mock.calls.at(-1)?.[0];
      expect(simulated).toBeInstanceOf(Transaction);
      expect((simulated as Transaction).toXDR()).toBe(fixture.envelopeXdr);
    });

    it("refuses that envelope at the unchanged 50000 default", async () => {
      const scheme = new ExactStellarScheme(facilitatorSigners);
      const requirements = publicRequirements(300);
      mockPublicSimulation(INCLUSION_LEDGER_RESOURCE_FEE);

      const result = await scheme.verify(publicPayload(requirements), requirements);
      expect(scheme.maxTransactionFeeStroops).toBe(50_000);
      expect(result).toEqual(
        invalidVerifyResponse(
          "invalid_exact_stellar_payload_fee_exceeds_maximum",
          PUBLIC_PAYER,
          `simulation-derived fee ${DERIVED_FEE} stroops exceeds ceiling 50000 stroops`,
        ),
      );
    });

    it("refuses that envelope when the explicit ceiling is 290099", async () => {
      const scheme = new ExactStellarScheme(facilitatorSigners, {
        maxTransactionFeeStroops: DERIVED_FEE - 1,
      });
      const requirements = publicRequirements(300);
      mockPublicSimulation(INCLUSION_LEDGER_RESOURCE_FEE);

      const result = await scheme.verify(publicPayload(requirements), requirements);
      expect(result).toEqual(
        invalidVerifyResponse(
          "invalid_exact_stellar_payload_fee_exceeds_maximum",
          PUBLIC_PAYER,
          `simulation-derived fee ${DERIVED_FEE} stroops exceeds ceiling ${DERIVED_FEE - 1} stroops`,
        ),
      );
    });

    it("still applies the auth expiration check to the contract payer", async () => {
      const scheme = new ExactStellarScheme(facilitatorSigners, {
        maxTransactionFeeStroops: DERIVED_FEE,
      });
      const requirements = publicRequirements(60);
      mockPublicSimulation(INCLUSION_LEDGER_RESOURCE_FEE, PUBLIC_LEDGER);

      const result = await scheme.verify(publicPayload(requirements), requirements);
      expect(result).toEqual(
        invalidVerifyResponse("invalid_exact_stellar_signature_expiration_too_far", PUBLIC_PAYER),
      );
    });
  });
});
