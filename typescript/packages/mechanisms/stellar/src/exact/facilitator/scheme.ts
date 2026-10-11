import {
  scValToNative,
  Transaction,
  FeeBumpTransaction,
  Address,
  Operation,
  xdr,
  rpc,
  TransactionBuilder,
  SignerKey,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { Api } from "@stellar/stellar-sdk/rpc";
import { STELLAR_WILDCARD_CAIP2 } from "../../constants";
import { gatherAuthEntrySignatureStatus, getAddressCredentials } from "../../shared";
import { ExactStellarPayloadV2 } from "../../types";
import {
  getEstimatedLedgerCloseTimeSeconds,
  getRpcClient,
  getNetworkPassphrase,
  isStellarNetwork,
  RpcConfig,
} from "../../utils";
import type { FacilitatorStellarSigner } from "../../signer";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";

const DEFAULT_TIMEOUT_SECONDS = 60;
const SUPPORTED_X402_VERSION = 2;
const DEFAULT_MAX_TRANSACTION_FEE_STROOPS = 50_000;
const SIGNATURE_EXPIRATION_LEDGER_TOLERANCE = 2;

/**
 * Returns a round-robin selector for choosing which signer to use.
 * Each invocation returns a new selector with its own counter.
 *
 * @returns A function that selects the next address from the given array on each call
 */
const roundRobinSelectSigner = (): ((addresses: readonly string[]) => string) => {
  let index = 0;
  return addrs => addrs[index++ % addrs.length];
};

/**
 * Helper to create a `VerifyResponse` with `isValid: false`.
 *
 * @param reason - The error reason code
 * @param payer - Optional payer address
 * @param message - Optional human-readable detail for invalidMessage
 * @returns a `VerifyResponse` with `isValid: false` and the provided reason and (optional) payer
 */
export function invalidVerifyResponse(
  reason: string,
  payer?: string,
  message?: string,
): VerifyResponse {
  return { isValid: false, invalidReason: reason, payer, invalidMessage: message };
}

/**
 * Helper to create a `VerifyResponse` with `isValid: true`.
 *
 * @param payer - The payer address
 * @returns a `VerifyResponse` with `isValid: true` and the provided payer
 */
export function validVerifyResponse(payer: string): VerifyResponse {
  return { isValid: true, payer };
}

type VerifyResult = {
  response: VerifyResponse;
  /** Present only when simulation succeeded (used by settle to derive the fee + fresh Soroban data). */
  simResponse?: Api.SimulateTransactionSuccessResponse;
};

/**
 * Stellar facilitator implementation for the Exact payment scheme.
 */
export class ExactStellarScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = STELLAR_WILDCARD_CAIP2;

  public readonly signingAddresses: ReadonlySet<string>;
  public readonly areFeesSponsored: boolean;
  public readonly rpcConfig?: RpcConfig;
  public readonly maxTransactionFeeStroops: number;
  public readonly inclusionFeeStroops: number;
  public readonly feeBumpSigner?: FacilitatorStellarSigner;
  private readonly signerMap: Map<string, FacilitatorStellarSigner>;
  private readonly selectSigner: (addresses: readonly string[]) => string;
  /**
   * Addresses the facilitator-safety checks must treat as facilitator-controlled.
   * Deliberately a separate set from `signingAddresses`: that set also backs
   * signer *selection* (`signerMap.get(...)` in `settle()`), and `feeBumpSigner`
   * has no entry in `signerMap`, so merging it into `signingAddresses` directly
   * would let round-robin selection pick an address `settle()` can't sign with.
   */
  private readonly facilitatorSafetyAddresses: ReadonlySet<string>;

  /**
   * Creates a new ExactStellarScheme instance.
   *
   * @param signers - One or more Stellar signers managed by the facilitator for settlement
   * @param options - Configuration options
   * @param options.rpcConfig - Optional RPC configuration with custom RPC URL
   * @param options.areFeesSponsored - Indicates if fees are sponsored (default: true)
   * @param options.maxTransactionFeeStroops - Safety ceiling in stroops; verify rejects if the simulation-derived fee exceeds this (default: 50_000). An explicit value authorizes that ceiling only and does not change the default.
   * @param options.inclusionFeeStroops - Inclusion fee bid in stroops for the settlement transaction and the fee bump, on top of the resource fee (default: 100).
   *   Mainnet often needs more than the minimum for Soroban transactions to be included.
   * @param options.selectSigner - Callback to select which signer to use (default: round-robin)
   * @param options.feeBumpSigner - Optional signer used as fee source in a fee bump transaction wrapper.
   *   When provided, settle() wraps the inner transaction (signed by the selected signer) in a
   *   FeeBumpTransaction where the feeBumpSigner pays the fees, decoupling fee payment from sequence number management.
   * @returns ExactStellarScheme instance
   */
  constructor(
    signers: FacilitatorStellarSigner[],
    {
      rpcConfig,
      areFeesSponsored = true,
      maxTransactionFeeStroops = DEFAULT_MAX_TRANSACTION_FEE_STROOPS,
      inclusionFeeStroops = Number(BASE_FEE),
      selectSigner = roundRobinSelectSigner(),
      feeBumpSigner,
    }: {
      /** Optional RPC configuration with custom RPC URL */
      rpcConfig?: RpcConfig;
      /** Indicates if fees are sponsored (default: true) */
      areFeesSponsored?: boolean;
      /** Safety ceiling in stroops; verify rejects if the simulation-derived fee exceeds this (default: 50_000). An explicit value does not change the default. */
      maxTransactionFeeStroops?: number;
      /** Inclusion fee bid in stroops for the settlement transaction and the fee bump (default: 100) */
      inclusionFeeStroops?: number;
      /** Optional callback to select which signer to use. Receives addresses array, returns selected address. Defaults to round-robin. */
      selectSigner?: (addresses: readonly string[]) => string;
      /** Optional signer used as fee source in a fee bump transaction wrapper. Decouples fee payment from sequence number management. */
      feeBumpSigner?: FacilitatorStellarSigner;
    } = {},
  ) {
    // Validate signers and store their data
    if (!signers || signers.length === 0) {
      throw new Error("At least one signer is required");
    }
    this.signerMap = new Map(signers.map(s => [s.address, s]));
    this.signingAddresses = new Set(this.signerMap.keys());

    // Apply configuration options (with defaults)
    this.rpcConfig = rpcConfig;
    this.areFeesSponsored = areFeesSponsored ?? true;
    this.maxTransactionFeeStroops = maxTransactionFeeStroops ?? DEFAULT_MAX_TRANSACTION_FEE_STROOPS;
    this.inclusionFeeStroops = inclusionFeeStroops ?? Number(BASE_FEE);
    this.selectSigner = selectSigner ?? roundRobinSelectSigner();
    this.feeBumpSigner = feeBumpSigner;
    this.facilitatorSafetyAddresses = this.feeBumpSigner
      ? new Set([...this.signingAddresses, this.feeBumpSigner.address])
      : this.signingAddresses;
  }

  /**
   * Get mechanism-specific extra data for the supported kinds endpoint.
   * For Stellar, returns `areFeesSponsored` indicating to clients if they can expect fees to be sponsored.
   * As of now, the spec only supports `areFeesSponsored: true`.
   *
   * @param _ - The network identifier (unused, offset is network-agnostic)
   * @returns Extra data with the `areFeesSponsored` flag
   */
  getExtra(_: Network): Record<string, unknown> | undefined {
    return {
      areFeesSponsored: this.areFeesSponsored,
    };
  }

  /**
   * Get signer addresses used by this facilitator.
   * For Stellar, returns all facilitator addresses including the fee bump signer when configured.
   *
   * @param _ - The network identifier (unused for Stellar)
   * @returns Array containing all facilitator addresses
   */
  getSigners(_: string): string[] {
    const signers = [...this.signingAddresses];
    if (this.feeBumpSigner && !this.signingAddresses.has(this.feeBumpSigner.address)) {
      signers.push(this.feeBumpSigner.address);
    }
    return signers;
  }

  /**
   * Verifies a payment payload.
   *
   * @param payload - The payment payload to verify
   * @param requirements - The payment requirements
   * @returns Promise resolving to verification response
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return (await this._verify(payload, requirements)).response;
  }

  /**
   * Settles a payment by submitting the transaction on-chain.
   *
   * @param payload - The payment payload to settle
   * @param requirements - The payment requirements
   * @returns Promise resolving to settlement response
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const server = getRpcClient(requirements.network, this.rpcConfig);
    const networkPassphrase = getNetworkPassphrase(requirements.network);
    let payer: string | undefined;
    let txHash: string | undefined;

    try {
      // Step 1: Verify payment before settlement
      const { response: verifyResult, simResponse } = await this._verify(payload, requirements);

      if (!verifyResult.isValid) {
        return {
          success: false,
          network: payload.accepted.network,
          transaction: "",
          errorReason: verifyResult.invalidReason ?? "verification_failed",
          payer: verifyResult.payer,
        };
      }

      if (!simResponse) {
        return {
          success: false,
          network: payload.accepted.network,
          transaction: "",
          errorReason: "unexpected_settle_error",
          payer: verifyResult.payer,
        };
      }

      payer = verifyResult.payer!;

      // Step 2: Parse transaction envelope to extract the operation
      const stellarPayload = payload.payload as ExactStellarPayloadV2;
      const transaction = new Transaction(stellarPayload.transaction, networkPassphrase);
      const sorobanData = simResponse.transactionData.build();

      // Step 3: Extract operation
      const invokeOp = transaction.operations[0] as Operation.InvokeHostFunction;

      // Step 4: Rebuild transaction with facilitator as source and simulation-derived fee
      const signer = this.signerMap.get(this.selectSigner([...this.signingAddresses]));
      if (!signer) {
        return {
          success: false,
          network: payload.accepted.network,
          transaction: "",
          errorReason: "settle_exact_stellar_signer_selection_failed",
          payer,
        };
      }
      const facilitatorAccount = await server.getAccount(signer.address);

      // SDK v16: `fee` is the inclusion buffer only; build() adds sorobanData.resourceFee()
      // from the settle-time simulation, so tx.fee = inclusionFeeStroops + minResourceFee.
      const rebuiltTx = new TransactionBuilder(facilitatorAccount, {
        fee: String(this.inclusionFeeStroops),
        networkPassphrase,
        ledgerbounds: transaction.ledgerBounds,
        memo: transaction.memo,
        minAccountSequence: transaction.minAccountSequence,
        minAccountSequenceAge: transaction.minAccountSequenceAge,
        minAccountSequenceLedgerGap: transaction.minAccountSequenceLedgerGap,
        extraSigners: transaction.extraSigners?.map(signerKey =>
          SignerKey.encodeSignerKey(signerKey),
        ),
        sorobanData,
      })
        .setTimeout(requirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)
        .addOperation(Operation.invokeHostFunction(invokeOp))
        .build();

      // Step 5: Sign inner transaction with the selected signer's key
      const { signedTxXdr, error: signError } = await signer.signTransaction(rebuiltTx.toXDR(), {
        networkPassphrase,
      });

      if (signError) {
        return {
          success: false,
          network: payload.accepted.network,
          transaction: "",
          errorReason: "settle_exact_stellar_transaction_signing_failed",
          payer,
        };
      }

      // Step 6: Optionally wrap in a fee bump transaction
      let txToSubmit: Transaction | FeeBumpTransaction;

      if (this.feeBumpSigner) {
        const signedInnerTx = TransactionBuilder.fromXDR(
          signedTxXdr,
          networkPassphrase,
        ) as Transaction;

        const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
          this.feeBumpSigner.address,
          // Same inclusion-only base fee; SDK adds the inner tx resource fee.
          String(this.inclusionFeeStroops),
          signedInnerTx,
          networkPassphrase,
        );

        const { signedTxXdr: signedFeeBumpXdr, error: feeBumpSignError } =
          await this.feeBumpSigner.signTransaction(feeBumpTx.toXDR(), { networkPassphrase });

        if (feeBumpSignError) {
          return {
            success: false,
            network: payload.accepted.network,
            transaction: "",
            errorReason: "settle_exact_stellar_fee_bump_signing_failed",
            payer,
          };
        }

        txToSubmit = TransactionBuilder.fromXDR(
          signedFeeBumpXdr,
          networkPassphrase,
        ) as FeeBumpTransaction;
      } else {
        txToSubmit = TransactionBuilder.fromXDR(signedTxXdr, networkPassphrase) as Transaction;
      }

      // Step 7: Submit transaction to network
      const sendResult = await server.sendTransaction(txToSubmit);

      if (sendResult.status !== "PENDING") {
        return {
          success: false,
          network: payload.accepted.network,
          transaction: "",
          errorReason: "settle_exact_stellar_transaction_submission_failed",
          payer,
        };
      }

      // Step 8: Poll for transaction confirmation
      txHash = sendResult.hash;
      const maxPollAttempts = requirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
      const confirmResult = await this.pollForTransaction(server, txHash, maxPollAttempts);

      if (!confirmResult.success) {
        return {
          success: false,
          network: payload.accepted.network,
          transaction: txHash,
          errorReason: "settle_exact_stellar_transaction_failed",
          payer,
        };
      }

      // Step 9: Return success
      return {
        success: true,
        transaction: txHash,
        network: payload.accepted.network,
        payer: payer,
      };
    } catch (error) {
      console.error("Unexpected settlement error:", error);
      return {
        success: false,
        network: payload.accepted.network,
        transaction: txHash || "",
        errorReason: "unexpected_settle_error",
        payer,
      };
    }
  }

  /**
   * Internal verification that also returns the simulation result for settlement.
   *
   * @param payload - The payment payload to verify
   * @param requirements - The payment requirements
   * @returns Verification response and optional simulation result
   */
  private async _verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResult> {
    let fromAddress: string | undefined;
    try {
      // Step 1: Validate protocol version, scheme, and network
      if (payload.x402Version !== SUPPORTED_X402_VERSION) {
        return { response: invalidVerifyResponse("invalid_x402_version") };
      }

      if (payload.accepted.scheme !== "exact" || requirements.scheme !== "exact") {
        return { response: invalidVerifyResponse("unsupported_scheme") };
      }

      if (requirements.network !== payload.accepted.network) {
        return { response: invalidVerifyResponse("network_mismatch") };
      }
      if (!isStellarNetwork(requirements.network)) {
        return { response: invalidVerifyResponse("invalid_network") };
      }

      const networkPassphrase = getNetworkPassphrase(requirements.network);
      const server = getRpcClient(requirements.network, this.rpcConfig);

      // Step 2: Parse and decode transaction
      const stellarPayload = payload.payload as ExactStellarPayloadV2;
      if (!stellarPayload || typeof stellarPayload.transaction !== "string") {
        return { response: invalidVerifyResponse("invalid_exact_stellar_payload_malformed") };
      }

      let transaction: Transaction;
      try {
        transaction = new Transaction(stellarPayload.transaction, networkPassphrase);
      } catch (error) {
        console.error("Error parsing transaction:", error);
        return { response: invalidVerifyResponse("invalid_exact_stellar_payload_malformed") };
      }

      // Step 3: Validate transaction structure
      if (transaction.operations.length !== 1) {
        return { response: invalidVerifyResponse("invalid_exact_stellar_payload_wrong_operation") };
      }

      const operation = transaction.operations[0];
      if (operation.type !== "invokeHostFunction") {
        return { response: invalidVerifyResponse("invalid_exact_stellar_payload_wrong_operation") };
      }

      if (
        this.facilitatorSafetyAddresses.has(operation.source ?? "") ||
        this.facilitatorSafetyAddresses.has(transaction.source)
      ) {
        return {
          response: invalidVerifyResponse("invalid_exact_stellar_payload_unsafe_tx_or_op_source"),
        };
      }

      // Step 4: Extract and validate contract invocation details
      const invokeOp = operation as Operation.InvokeHostFunction;
      const func = invokeOp.func;

      if (!func || func.switch().name !== "hostFunctionTypeInvokeContract") {
        return { response: invalidVerifyResponse("invalid_exact_stellar_payload_wrong_operation") };
      }

      // Step 5: Validate contract address and function name
      const invokeContractArgs = func.invokeContract();
      const contractAddress = Address.fromScAddress(
        invokeContractArgs.contractAddress(),
      ).toString();
      const functionName = invokeContractArgs.functionName().toString();

      const args = invokeContractArgs.args();
      if (contractAddress !== requirements.asset) {
        return { response: invalidVerifyResponse("invalid_exact_stellar_payload_wrong_asset") };
      }

      if (functionName !== "transfer" || args.length !== 3) {
        return {
          response: invalidVerifyResponse("invalid_exact_stellar_payload_wrong_function_name"),
        };
      }

      // Step 6: Extract and validate transfer arguments
      fromAddress = scValToNative(args[0]) as string;
      const toAddress = scValToNative(args[1]) as string;
      const amount = scValToNative(args[2]) as bigint;

      if (this.facilitatorSafetyAddresses.has(fromAddress)) {
        return {
          response: invalidVerifyResponse("invalid_exact_stellar_payload_facilitator_is_payer"),
        };
      }

      if (toAddress !== requirements.payTo) {
        return {
          response: invalidVerifyResponse(
            "invalid_exact_stellar_payload_wrong_recipient",
            fromAddress,
          ),
        };
      }

      const expectedAmount = BigInt(requirements.amount);
      if (amount !== expectedAmount) {
        return {
          response: invalidVerifyResponse(
            "invalid_exact_stellar_payload_wrong_amount",
            fromAddress,
          ),
        };
      }

      // Step 7: Re-simulate to ensure transaction will succeed
      const simResponse = await server.simulateTransaction(transaction);
      if (!Api.isSimulationSuccess(simResponse)) {
        const errorMsg = simResponse.error ? `: ${simResponse.error}` : "";
        console.error("Simulation error:", errorMsg);
        return {
          response: invalidVerifyResponse(
            "invalid_exact_stellar_payload_simulation_failed",
            fromAddress,
          ),
        };
      }

      // Step 8: Validate the simulation-derived settlement fee against the safety ceiling
      const minResourceFee = parseInt(simResponse.minResourceFee, 10);
      const settlementFeeStroops = minResourceFee + this.inclusionFeeStroops;
      if (settlementFeeStroops > this.maxTransactionFeeStroops) {
        return {
          response: invalidVerifyResponse(
            "invalid_exact_stellar_payload_fee_exceeds_maximum",
            fromAddress,
            `simulation-derived fee ${settlementFeeStroops} stroops exceeds ceiling ${this.maxTransactionFeeStroops} stroops`,
          ),
        };
      }

      // Step 9: Validate simulation events. Exactly one asset transfer is required.
      // One matching OpenZeppelin spending_limit_enforced event may accompany it.
      const eventValidation = this.validateSimulationEvents(
        simResponse.events,
        fromAddress,
        requirements.payTo,
        expectedAmount,
        requirements.asset,
      );
      if (eventValidation) {
        return { response: eventValidation };
      }

      const latestLedger = await server.getLatestLedger();
      const currentLedger = latestLedger.sequence;
      const maxTimeoutSeconds = requirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
      const estimatedLedgerSeconds = await getEstimatedLedgerCloseTimeSeconds(requirements.network);
      const maxLedgerOffset = Math.ceil(maxTimeoutSeconds / estimatedLedgerSeconds);
      const maxLedger = currentLedger + maxLedgerOffset;

      // Step 10: Validate auth entries (structure, credential type, expiration, facilitator safety, and signature status).
      const authValidation = this.validateAuthEntries(
        invokeOp,
        this.facilitatorSafetyAddresses,
        fromAddress,
        maxLedger,
        transaction,
        simResponse,
      );
      if (authValidation) {
        return { response: authValidation };
      }

      return { response: validVerifyResponse(fromAddress), simResponse };
    } catch (error) {
      console.error("Unexpected verification error:", error);
      return { response: invalidVerifyResponse("unexpected_verify_error", fromAddress) };
    }
  }

  /**
   * Polls for transaction confirmation on Soroban.
   *
   * @param server - Soroban RPC server
   * @param txHash - Transaction hash to poll for
   * @param maxPollAttempts - Maximum number of polling attempts (default: 15)
   * @param delayMs - Delay between attempts in milliseconds (default: 1000)
   * @returns Result with success status
   */
  private async pollForTransaction(
    server: rpc.Server,
    txHash: string,
    maxPollAttempts = 15,
    delayMs = 1000,
  ): Promise<{ success: boolean }> {
    for (let i = 0; i < maxPollAttempts; i++) {
      try {
        const txResult = await server.getTransaction(txHash);

        if (txResult.status === "SUCCESS") {
          return { success: true };
        } else if (txResult.status === "FAILED") {
          return { success: false };
        }

        // Transaction still pending, wait and retry
        await new Promise(resolve => setTimeout(resolve, delayMs));
      } catch (error: unknown) {
        if (error instanceof Error && !error.message.includes("NOT_FOUND")) {
          console.warn(`Poll attempt ${i} failed:`, error);
        }
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    // Timeout
    return { success: false };
  }

  /**
   * Validates simulation events for transfer correctness.
   * Ensures there is exactly one token transfer event, the transfer matches the
   * expected sender, recipient, amount, and asset (contract address), and the
   * facilitator address is not involved in the transfer.
   * A single OpenZeppelin `spending_limit_enforced` event is allowed only when
   * its smart account, amount, and transfer context match that transfer.
   *
   * @param events - The array of DiagnosticEvent objects from the simulation
   * @param fromAddress - The payer's address
   * @param toAddress - The recipient's address
   * @param expectedAmount - The expected transfer amount
   * @param expectedAsset - The expected token contract address
   * @returns undefined if the validation succeeds, otherwise an invalid VerifyResponse
   */
  private validateSimulationEvents(
    events: xdr.DiagnosticEvent[],
    fromAddress: string,
    toAddress: string,
    expectedAmount: bigint,
    expectedAsset: string,
  ): VerifyResponse | undefined {
    // Soroban token transfer events follow the [CAP-46](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0046-06.md) format:
    // Topic: ["transfer", from, to], Data: amount
    const transferEvents: Array<{
      from: string;
      to: string;
      amount: bigint;
    }> = [];
    let acceptedSpendingLimitEnforced = false;

    // Parse events into
    for (const diagnosticEvent of events) {
      try {
        const event = diagnosticEvent.event();

        // Skip non-contract events
        if (event.type().name !== "contract") {
          continue;
        }

        const body = event.body().v0();
        const topics = body.topics();
        const symbol = readScSymbol(topics[0]);

        // OpenZeppelin SpendingLimitEnforced is two topics and is not a balance change.
        // It is tolerated only from a contract other than the asset. The same symbol
        // from the asset contract stays on the asset-event path below.
        // Any other short event, including sibling policy events, stays rejected.
        if (
          symbol === SPENDING_LIMIT_ENFORCED_SYMBOL &&
          contractEventAddress(event) !== expectedAsset
        ) {
          const rejection = spendingLimitEnforcedRejection(
            event,
            topics,
            body.data(),
            fromAddress,
            toAddress,
            expectedAmount,
            expectedAsset,
          );
          if (rejection) {
            return rejection;
          }
          if (acceptedSpendingLimitEnforced) {
            return invalidVerifyResponse(CONTRADICTORY_AUTHORIZATION_REASON, fromAddress);
          }
          acceptedSpendingLimitEnforced = true;
          continue;
        }

        // transfer, mint, burn, and clawback from any contract stay on this path.
        if (topics.length < 3 || symbol !== "transfer") {
          return invalidVerifyResponse(
            "invalid_exact_stellar_payload_event_not_transfer",
            fromAddress,
          );
        }

        const contractIdHash = event.contractId();
        if (!contractIdHash)
          return invalidVerifyResponse(
            "invalid_exact_stellar_payload_event_missing_contract_id",
            fromAddress,
          );
        const eventContractAddress = Address.fromScAddress(
          xdr.ScAddress.scAddressTypeContract(contractIdHash),
        ).toString();
        if (eventContractAddress !== expectedAsset) {
          return invalidVerifyResponse(
            "invalid_exact_stellar_payload_event_wrong_asset",
            fromAddress,
          );
        }

        // Extract from, to, and amount
        const from = scValToNative(topics[1]) as string;
        const to = scValToNative(topics[2]) as string;
        const amount = scValToNative(body.data()) as bigint;

        transferEvents.push({ from, to, amount });
      } catch (error: unknown) {
        if (error instanceof Error) {
          console.error("Error parsing diagnostic event:", error.message);
        } else {
          console.error("Error parsing diagnostic event:", String(error));
        }
        return invalidVerifyResponse("unexpected_verify_error", fromAddress);
      }
    }

    // If no transfer events are present, reject.
    if (transferEvents.length === 0) {
      return invalidVerifyResponse("invalid_exact_stellar_payload_no_transfer_events", fromAddress);
    }

    if (transferEvents.length > 1) {
      return invalidVerifyResponse("invalid_exact_stellar_payload_multiple_transfers", fromAddress);
    }

    const transferEvent = transferEvents[0];

    // Validate the transfer matches the expected sender, recipient, and amount
    if (transferEvent.from !== fromAddress) {
      return invalidVerifyResponse("invalid_exact_stellar_payload_event_wrong_from", fromAddress);
    }
    if (transferEvent.to !== toAddress) {
      return invalidVerifyResponse("invalid_exact_stellar_payload_event_wrong_to", fromAddress);
    }
    if (transferEvent.amount !== expectedAmount) {
      return invalidVerifyResponse("invalid_exact_stellar_payload_event_wrong_amount", fromAddress);
    }

    return undefined;
  }

  /**
   * Validates authorization entries: structure, credential type, expiration,
   * facilitator safety, no sub-invocations, and that the payer has signed and
   * no other signatures are pending (per simulation).
   *
   * @param invokeOp - The invoke host function operation
   * @param facilitatorAddresses - Set of all facilitator addresses
   * @param fromAddress - The payer's address (for error reporting)
   * @param maxLedger - The maximum allowed expiration ledger
   * @param transaction - The full transaction (for signature status)
   * @param simResponse - The simulation result (used to interpret auth entry signatures)
   * @returns Invalid VerifyResponse when validation fails
   */
  private validateAuthEntries(
    invokeOp: Operation.InvokeHostFunction,
    facilitatorAddresses: ReadonlySet<string>,
    fromAddress: string,
    maxLedger: number,
    transaction: Transaction,
    simResponse: Api.SimulateTransactionSuccessResponse,
  ): VerifyResponse | undefined {
    if (!invokeOp.auth || invokeOp.auth.length === 0) {
      return invalidVerifyResponse("invalid_exact_stellar_payload_no_auth_entries", fromAddress);
    }

    for (const auth of invokeOp.auth) {
      // Only address-based credentials are allowed: legacy V1 or CAP-71 V2,
      // which the network accepts from Protocol 28 onward. Source-account and
      // delegated credentials are rejected.
      const addressCredentials = getAddressCredentials(auth.credentials());
      if (!addressCredentials) {
        return invalidVerifyResponse(
          "invalid_exact_stellar_payload_unsupported_credential_type",
          fromAddress,
        );
      }

      const authAddress = Address.fromScAddress(addressCredentials.address()).toString();

      // Facilitator must not appear in auth entries
      if (facilitatorAddresses.has(authAddress)) {
        return invalidVerifyResponse(
          "invalid_exact_stellar_payload_facilitator_in_auth",
          fromAddress,
        );
      }

      // Check signature expiration is within allowed window (with ledger tolerance for RPC skew)
      const expirationLedger = addressCredentials.signatureExpirationLedger();
      if (expirationLedger > maxLedger + SIGNATURE_EXPIRATION_LEDGER_TOLERANCE) {
        return invalidVerifyResponse(
          "invalid_exact_stellar_signature_expiration_too_far",
          fromAddress,
        );
      }

      // No sub-invocations allowed
      const rootInvocation = auth.rootInvocation();
      if (rootInvocation.subInvocations().length > 0) {
        return invalidVerifyResponse(
          "invalid_exact_stellar_payload_has_subinvocations",
          fromAddress,
        );
      }
    }

    const authStatus = gatherAuthEntrySignatureStatus({
      transaction,
      simulationResponse: simResponse,
    });
    if (!authStatus.alreadySigned.includes(fromAddress)) {
      return invalidVerifyResponse(
        "invalid_exact_stellar_payload_missing_payer_signature",
        fromAddress,
      );
    }
    if (authStatus.pendingSignature.length > 0) {
      return invalidVerifyResponse(
        "invalid_exact_stellar_payload_unexpected_pending_signatures",
        fromAddress,
      );
    }

    return undefined;
  }
}

const SPENDING_LIMIT_ENFORCED_SYMBOL = "spending_limit_enforced";
const MALFORMED_POLICY_EVENT_REASON = "invalid_exact_stellar_payload_malformed_policy_event";
const CONTRADICTORY_AUTHORIZATION_REASON =
  "invalid_exact_stellar_payload_contradictory_authorization";
const POLICY_DATA_KEYS = ["amount", "context", "context_rule_id", "total_spent_in_period"];
const TRANSFER_CONTEXT_KEYS = ["args", "contract", "fn_name"];

/**
 * Returns the contract address that published an event.
 *
 * @param event - Contract event from a diagnostic event
 * @returns the contract address, or undefined when the event has no contract id
 */
function contractEventAddress(event: xdr.ContractEvent): string | undefined {
  const contractIdHash = event.contractId();
  if (!contractIdHash) {
    return undefined;
  }
  return Address.fromScAddress(xdr.ScAddress.scAddressTypeContract(contractIdHash)).toString();
}

/**
 * Reads a Soroban symbol.
 *
 * @param val - ScVal that may be a symbol
 * @returns the symbol text, or undefined when the value is not a symbol
 */
function readScSymbol(val: xdr.ScVal | undefined): string | undefined {
  if (!val || val.switch().name !== "scvSymbol") {
    return undefined;
  }
  return val.sym().toString();
}

/**
 * Reads an address ScVal as a string.
 *
 * @param val - ScVal that may be an address
 * @returns the address string, or undefined when the value is not an address
 */
function readScAddress(val: xdr.ScVal): string | undefined {
  if (val.switch().name !== "scvAddress") {
    return undefined;
  }
  try {
    const native = scValToNative(val);
    return typeof native === "string" ? native : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads an i128 ScVal.
 *
 * @param val - ScVal that may be an i128
 * @returns the bigint, or undefined when the value is not an i128
 */
function readScI128(val: xdr.ScVal): bigint | undefined {
  if (val.switch().name !== "scvI128") {
    return undefined;
  }
  try {
    const native = scValToNative(val);
    return typeof native === "bigint" ? native : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads a u32 ScVal.
 *
 * @param val - ScVal that may be a u32
 * @returns the number, or undefined when the value is not a u32
 */
function readScU32(val: xdr.ScVal): number | undefined {
  if (val.switch().name !== "scvU32") {
    return undefined;
  }
  return val.u32();
}

/**
 * Reads a Soroban vector.
 *
 * @param val - ScVal that may be a vector
 * @returns the elements, or undefined when the value is not a vector
 */
function readScVec(val: xdr.ScVal): xdr.ScVal[] | undefined {
  if (val.switch().name !== "scvVec") {
    return undefined;
  }
  const items = val.vec();
  return items ? [...items] : undefined;
}

/**
 * Reads a symbol-keyed Soroban map.
 *
 * @param val - ScVal that may be a map
 * @returns entries keyed by symbol, or undefined when a key is not a unique symbol
 */
function readSymbolMap(val: xdr.ScVal): Map<string, xdr.ScVal> | undefined {
  if (val.switch().name !== "scvMap") {
    return undefined;
  }
  const entries = val.map();
  if (!entries) {
    return undefined;
  }
  const out = new Map<string, xdr.ScVal>();
  for (const entry of entries) {
    const name = readScSymbol(entry.key());
    if (name === undefined || out.has(name)) {
      return undefined;
    }
    out.set(name, entry.val());
  }
  return out;
}

interface SpendingLimitFields {
  context: xdr.ScVal;
  contextRuleId: xdr.ScVal;
  amount: xdr.ScVal;
  totalSpentInPeriod: xdr.ScVal;
}

/**
 * Reads OpenZeppelin SpendingLimitEnforced data.
 * soroban-sdk 26.1.0 defaults `#[contractevent]` data to a map. The documented
 * list is the same four fields in declaration order.
 *
 * @param data - Event data ScVal
 * @returns the four fields, or undefined when the value is neither accepted shape
 */
function readSpendingLimitFields(data: xdr.ScVal): SpendingLimitFields | undefined {
  const map = readSymbolMap(data);
  if (map) {
    if (map.size !== POLICY_DATA_KEYS.length) {
      return undefined;
    }
    const context = map.get("context");
    const contextRuleId = map.get("context_rule_id");
    const amount = map.get("amount");
    const totalSpentInPeriod = map.get("total_spent_in_period");
    if (!context || !contextRuleId || !amount || !totalSpentInPeriod) {
      return undefined;
    }
    return { context, contextRuleId, amount, totalSpentInPeriod };
  }

  const items = readScVec(data);
  if (!items || items.length !== 4) {
    return undefined;
  }
  return {
    context: items[0],
    contextRuleId: items[1],
    amount: items[2],
    totalSpentInPeriod: items[3],
  };
}

/**
 * Checks that a policy context is the Contract variant of this SEP-41 transfer.
 * Context is the soroban-sdk 26.1.0 contracttype encoding: a two-element vector
 * of the variant symbol and a map of contract, fn_name, and args.
 *
 * @param context - Context ScVal from the policy event
 * @param asset - Expected token contract address
 * @param fromAddress - Expected payer
 * @param toAddress - Expected recipient
 * @param expectedAmount - Expected transfer amount
 * @returns ok, malformed when the encoding is not a contract context, or contradictory when it names a different call
 */
function transferContextStatus(
  context: xdr.ScVal,
  asset: string,
  fromAddress: string,
  toAddress: string,
  expectedAmount: bigint,
): "ok" | "malformed" | "contradictory" {
  const items = readScVec(context);
  if (!items || items.length !== 2) {
    return "malformed";
  }
  const discriminant = readScSymbol(items[0]);
  if (discriminant === undefined) {
    return "malformed";
  }
  if (discriminant !== "Contract") {
    return "contradictory";
  }
  const fields = readSymbolMap(items[1]);
  if (!fields || fields.size !== TRANSFER_CONTEXT_KEYS.length) {
    return "malformed";
  }
  const contractVal = fields.get("contract");
  const fnVal = fields.get("fn_name");
  const argsVal = fields.get("args");
  if (!contractVal || !fnVal || !argsVal) {
    return "malformed";
  }
  const contract = readScAddress(contractVal);
  if (contract === undefined) {
    return "malformed";
  }
  if (contract !== asset) {
    return "contradictory";
  }
  const fnName = readScSymbol(fnVal);
  if (fnName === undefined) {
    return "malformed";
  }
  if (fnName !== "transfer") {
    return "contradictory";
  }
  const args = readScVec(argsVal);
  if (!args) {
    return "malformed";
  }
  if (args.length !== 3) {
    return "contradictory";
  }
  const argFrom = readScAddress(args[0]);
  const argTo = readScAddress(args[1]);
  const argAmount = readScI128(args[2]);
  if (argFrom === undefined || argTo === undefined || argAmount === undefined) {
    return "malformed";
  }
  if (argFrom !== fromAddress || argTo !== toAddress || argAmount !== expectedAmount) {
    return "contradictory";
  }
  return "ok";
}

/**
 * Accepts one OpenZeppelin spending_limit_enforced event that authorizes this transfer.
 * The caller has already excluded an event published by the asset contract.
 * The event does not move funds. enforce() publishes it only for a positive SEP-41
 * transfer, with the smart account as the topic and that transfer's i128 amount in the data.
 * Sibling policy events are not authorization of this payment.
 *
 * @param event - Contract event being inspected
 * @param topics - Event topics, whose first entry is spending_limit_enforced
 * @param data - Event data
 * @param fromAddress - Payer from the invoke arguments
 * @param toAddress - Expected recipient
 * @param expectedAmount - Expected transfer amount
 * @param expectedAsset - Expected token contract
 * @returns undefined when the event matches, otherwise a malformed or contradictory verify response
 */
function spendingLimitEnforcedRejection(
  event: xdr.ContractEvent,
  topics: xdr.ScVal[],
  data: xdr.ScVal,
  fromAddress: string,
  toAddress: string,
  expectedAmount: bigint,
  expectedAsset: string,
): VerifyResponse | undefined {
  if (topics.length !== 2) {
    return invalidVerifyResponse(MALFORMED_POLICY_EVENT_REASON, fromAddress);
  }
  const smartAccount = readScAddress(topics[1]);
  if (smartAccount === undefined) {
    return invalidVerifyResponse(MALFORMED_POLICY_EVENT_REASON, fromAddress);
  }
  if (smartAccount !== fromAddress) {
    return invalidVerifyResponse(CONTRADICTORY_AUTHORIZATION_REASON, fromAddress);
  }
  if (!event.contractId()) {
    return invalidVerifyResponse(MALFORMED_POLICY_EVENT_REASON, fromAddress);
  }

  const fields = readSpendingLimitFields(data);
  if (!fields) {
    return invalidVerifyResponse(MALFORMED_POLICY_EVENT_REASON, fromAddress);
  }
  const contextRuleId = readScU32(fields.contextRuleId);
  const amount = readScI128(fields.amount);
  const totalSpentInPeriod = readScI128(fields.totalSpentInPeriod);
  if (contextRuleId === undefined || amount === undefined || totalSpentInPeriod === undefined) {
    return invalidVerifyResponse(MALFORMED_POLICY_EVENT_REASON, fromAddress);
  }
  if (amount !== expectedAmount || totalSpentInPeriod < amount) {
    return invalidVerifyResponse(CONTRADICTORY_AUTHORIZATION_REASON, fromAddress);
  }

  const contextStatus = transferContextStatus(
    fields.context,
    expectedAsset,
    fromAddress,
    toAddress,
    expectedAmount,
  );
  if (contextStatus === "ok") {
    return undefined;
  }
  return invalidVerifyResponse(
    contextStatus === "malformed"
      ? MALFORMED_POLICY_EVENT_REASON
      : CONTRADICTORY_AUTHORIZATION_REASON,
    fromAddress,
  );
}
