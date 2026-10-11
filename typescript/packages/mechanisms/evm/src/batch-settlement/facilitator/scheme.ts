import {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  FacilitatorContext,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { InMemoryPendingSettlementStore, PendingSettlementStore } from "@x402/core/facilitator";
import { FacilitatorEvmSigner } from "../../signer";
import { BATCH_SETTLEMENT_SCHEME } from "../constants";
import {
  isBatchSettlementDepositPayload,
  isBatchSettlementVoucherPayload,
  isBatchSettlementClaimPayload,
  isBatchSettlementSettlePayload,
  isBatchSettlementRefundPayload,
  isBatchSettlementEnrichedRefundPayload,
} from "../types";
import type { AuthorizerSigner } from "../types";
import { verifyDeposit, settleDeposit } from "./deposit";
import { verifyVoucher } from "./voucher";
import { executeClaimWithSignature } from "./claim";
import { executeSettle } from "./settle";
import { executeRefundWithSignature } from "./refund";
import { resolveDataSuffix } from "../../shared/extensions";
import * as Errors from "../errors";
import { ErrSettlementPending } from "../../exact/facilitator/errors";
import { batchOperationFingerprint, type BatchOperation } from "./operation";
import { unsignedEip155ChainId } from "../server/receiverState";
import { computeChannelId } from "../utils";

export interface BatchSettlementEvmSchemeConfig {
  /**
   * Allowlist of factory contract addresses (hex strings, case-insensitive) the facilitator
   * will call to deploy an undeployed (ERC-6492 counterfactual) smart wallet before an
   * ERC-3009 deposit. An empty or omitted list denies all factory deployment (feature
   * disabled by default).
   *
   * @default []
   */
  eip6492AllowedFactories?: string[];
  /**
   * Lets a retried deposit settle for the same authorization reconcile
   * against an already-broadcast transaction instead of re-broadcasting
   * (see {@link PendingSettlementStore}). Only the deposit settle path
   * consults this store; claim/settle/refund are single-signature onchain
   * calls with no equivalent broadcast-then-reconcile flow. Defaults to a
   * fresh in-memory store shared across all deposit settle calls on this
   * scheme instance. Inject a shared, network-backed implementation (e.g.
   * Redis) for a multi-instance facilitator so a settle retry landing on a
   * different replica still reconciles correctly.
   */
  pendingSettlementStore?: PendingSettlementStore;
}

/**
 * Facilitator-side implementation of the `batch-settlement` scheme for EVM networks.
 *
 * Routes incoming verify/settle requests to the appropriate handler based on payload
 * type (deposit, voucher, claim, settle, refund).
 */
export class BatchSettlementEvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = BATCH_SETTLEMENT_SCHEME;
  readonly caipFamily = "eip155:*";
  private readonly config: Required<Omit<BatchSettlementEvmSchemeConfig, "pendingSettlementStore">>;
  private readonly pendingStore: PendingSettlementStore;
  private readonly batchOperations = new Map<string, BatchOperation>();

  /**
   * Creates a facilitator scheme for verifying and settling batch-settlement payments.
   *
   * @param signer - Facilitator EVM signer(s) used for tx submission and onchain reads.
   * @param authorizerSigner - Optional dedicated key that provides EIP-712 signatures for
   *   `claimWithSignature` / `refundWithSignature`. When provided, the facilitator advertises
   *   its address as `receiverAuthorizer` in `/supported` and signs missing authorizer
   *   signatures using this key when the server omits them. A facilitator that advertises a
   *   `receiverAuthorizer` for servers to delegate to must authenticate refund requests (see the
   *   spec); when no such mechanism exists, omit this signer so no `receiverAuthorizer` is
   *   advertised and servers supply their own signatures.
   * @param config - Optional configuration (e.g. ERC-6492 factory allowlist).
   */
  constructor(
    private readonly signer: FacilitatorEvmSigner,
    private readonly authorizerSigner?: AuthorizerSigner,
    config?: BatchSettlementEvmSchemeConfig,
  ) {
    this.config = {
      eip6492AllowedFactories: config?.eip6492AllowedFactories ?? [],
    };
    this.pendingStore = config?.pendingSettlementStore ?? new InMemoryPendingSettlementStore();
  }

  /**
   * Returns facilitator-specific extra fields to be merged into payment requirements.
   *
   * Exposes the configured `receiverAuthorizer` address so the server and client can
   * embed it in `ChannelConfig`. Returns `undefined` when no authorizer signer is
   * configured, signalling that servers must supply their own authorizer signatures.
   *
   * @param _ - Network identifier (unused).
   * @returns Extra fields containing `receiverAuthorizer`, or `undefined`.
   */
  getExtra(_: string): { receiverAuthorizer: `0x${string}` } | undefined {
    if (!this.authorizerSigner) {
      return undefined;
    }
    return { receiverAuthorizer: this.authorizerSigner.address };
  }

  /**
   * Returns all facilitator signer addresses available for the given network.
   *
   * @param _ - Network identifier (unused).
   * @returns Array of hex addresses.
   */
  getSigners(_: string): `0x${string}`[] {
    return [...this.signer.getAddresses()];
  }

  /**
   * Verifies a payment payload (deposit or voucher) without executing settlement.
   *
   * @param payload - The x402 payment payload envelope.
   * @param requirements - Server payment requirements (scheme, network, asset, amount).
   * @param context - Optional facilitator extension context.
   * @param _ - Payment required extensions (unused; reserved for interface parity)
   * @returns A {@link VerifyResponse} indicating validity with payer and channel state in `extra`.
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
    _?: Record<string, unknown>,
  ): Promise<VerifyResponse> {
    const rawPayload = payload.payload;

    if (
      payload.accepted.scheme !== BATCH_SETTLEMENT_SCHEME ||
      requirements.scheme !== BATCH_SETTLEMENT_SCHEME
    ) {
      return { isValid: false, invalidReason: Errors.ErrInvalidScheme };
    }

    if (payload.accepted.network !== requirements.network) {
      return { isValid: false, invalidReason: Errors.ErrNetworkMismatch };
    }

    if (isBatchSettlementDepositPayload(rawPayload)) {
      return verifyDeposit(
        this.signer,
        payload,
        rawPayload,
        requirements,
        context,
        this.config.eip6492AllowedFactories,
      );
    }

    if (isBatchSettlementVoucherPayload(rawPayload)) {
      return verifyVoucher(this.signer, rawPayload, requirements, rawPayload.channelConfig);
    }

    if (isBatchSettlementRefundPayload(rawPayload)) {
      return verifyVoucher(this.signer, rawPayload, requirements, rawPayload.channelConfig);
    }

    return { isValid: false, invalidReason: Errors.ErrInvalidPayloadType };
  }

  /**
   * Executes settlement for a payment payload.
   *
   * Dispatches to the correct handler based on payload settle action:
   * - `deposit` → onchain `deposit(config, amount, collector, collectorData)`
   * - `claim` → onchain `claimWithSignature(VoucherClaim[], bytes)`
   * - `settle` → onchain `settle(receiver, token)`
   * - `refund` → optional claim + onchain `refundWithSignature(config, amount, nonce, sig)`
   *
   * @param payload - The x402 payment payload envelope.
   * @param requirements - Server payment requirements.
   * @param context - Optional facilitator extension context.
   * @returns A {@link SettleResponse} with the transaction hash on success.
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<SettleResponse> {
    // A caller may mutate its objects while an RPC or extension resolves.
    // The admitted operation always retains its original wire input and terms.
    payload = structuredClone(payload);
    requirements = structuredClone(requirements);
    const rawPayload = payload.payload;

    const dataSuffix = await resolveDataSuffix(context, {
      paymentPayload: payload,
      paymentRequirements: requirements,
    });

    if (isBatchSettlementDepositPayload(rawPayload)) {
      return settleDeposit(
        this.signer,
        payload,
        rawPayload,
        requirements,
        context,
        dataSuffix,
        this.config.eip6492AllowedFactories,
        this.pendingStore,
      );
    }

    if (isBatchSettlementClaimPayload(rawPayload)) {
      return this.runBatchOperation(
        payload,
        requirements,
        dataSuffix,
        rawPayload.claims.flatMap(claim => [
          `config:${batchOperationFingerprint(claim.voucher.channel)}`,
          `channel:${computeChannelId(claim.voucher.channel, requirements.network).toLowerCase()}`,
        ]),
        (signer, operation) =>
          executeClaimWithSignature(
            signer,
            rawPayload,
            requirements,
            this.authorizerSigner,
            dataSuffix,
            operation,
          ),
      );
    }

    if (isBatchSettlementEnrichedRefundPayload(rawPayload)) {
      return this.runBatchOperation(
        payload,
        requirements,
        dataSuffix,
        [
          `config:${batchOperationFingerprint(rawPayload.channelConfig)}`,
          `channel:${rawPayload.voucher.channelId.toLowerCase()}`,
        ],
        (signer, operation) =>
          executeRefundWithSignature(
            signer,
            rawPayload,
            requirements,
            this.authorizerSigner,
            dataSuffix,
            operation,
          ),
      );
    }

    if (isBatchSettlementSettlePayload(rawPayload)) {
      return this.runBatchOperation(
        payload,
        requirements,
        dataSuffix,
        [`receiver:${rawPayload.receiver.toLowerCase()}:${rawPayload.token.toLowerCase()}`],
        (signer, operation) =>
          executeSettle(signer, rawPayload, requirements, dataSuffix, operation),
      );
    }

    return {
      success: false,
      errorReason: Errors.ErrInvalidPayloadType,
      transaction: "",
      network: requirements.network,
    };
  }

  /**
   * Retains the existing handler's confirmation continuation for one admitted batch
   * operation. A retry with identical wire input only waits on that transaction;
   * changed terms on an unresolved channel/pair cannot sign or broadcast again.
   * This is instance-local continuity, not a durable or cross-replica transaction service.
   *
   * @param payload - Original wire request.
   * @param requirements - Accepted payment requirements.
   * @param dataSuffix - Resolved transaction suffix.
   * @param scopes - Channel and receiver-pair identities affected by the request.
   * @param execute - Existing native batch handler.
   * @returns Its confirmed response or an unresolved original effect.
   */
  private async runBatchOperation(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    dataSuffix: `0x${string}` | undefined,
    scopes: string[],
    execute: (signer: FacilitatorEvmSigner, operation: BatchOperation) => Promise<SettleResponse>,
  ): Promise<SettleResponse> {
    unsignedEip155ChainId(requirements.network);
    if (
      payload.accepted.scheme !== requirements.scheme ||
      payload.accepted.network !== requirements.network
    ) {
      return {
        success: false,
        errorReason: Errors.ErrNetworkMismatch,
        transaction: "",
        network: requirements.network,
      };
    }
    const raw = payload.payload;
    const configs = isBatchSettlementClaimPayload(raw)
      ? raw.claims.map(claim => claim.voucher.channel)
      : isBatchSettlementEnrichedRefundPayload(raw)
        ? [raw.channelConfig]
        : [];
    if (
      configs.some(config => config.receiver.toLowerCase() !== requirements.payTo.toLowerCase()) ||
      (isBatchSettlementSettlePayload(raw) &&
        raw.receiver.toLowerCase() !== requirements.payTo.toLowerCase())
    ) {
      return {
        success: false,
        errorReason: Errors.ErrReceiverMismatch,
        transaction: "",
        network: requirements.network,
      };
    }
    if (
      configs.some(config => config.token.toLowerCase() !== requirements.asset.toLowerCase()) ||
      (isBatchSettlementSettlePayload(raw) &&
        raw.token.toLowerCase() !== requirements.asset.toLowerCase())
    ) {
      return {
        success: false,
        errorReason: Errors.ErrTokenMismatch,
        transaction: "",
        network: requirements.network,
      };
    }
    if (
      isBatchSettlementEnrichedRefundPayload(raw) &&
      computeChannelId(raw.channelConfig, requirements.network).toLowerCase() !==
        raw.voucher.channelId.toLowerCase()
    ) {
      return {
        success: false,
        errorReason: Errors.ErrChannelIdMismatch,
        transaction: "",
        network: requirements.network,
      };
    }
    const fingerprint = batchOperationFingerprint({ payload, requirements, dataSuffix });
    const previous = scopes.map(scope => this.batchOperations.get(scope)).find(Boolean);
    if (previous && previous.fingerprint !== fingerprint) {
      return {
        success: false,
        errorReason: Errors.ErrChannelBusy,
        errorMessage: "prior batch operation is unresolved; this changed request was not submitted",
        transaction: "",
        network: requirements.network,
      };
    }
    const operation: BatchOperation = previous ?? {
      fingerprint,
      network: requirements.network,
      broadcastStarted: false,
    };
    if (operation.flight) return operation.flight;
    if (previous && !operation.confirm) {
      return {
        success: false,
        errorReason: ErrSettlementPending,
        errorMessage:
          "prior broadcast outcome is unknown; no new signature or broadcast is permitted",
        transaction: operation.transaction ?? "",
        network: operation.network,
      };
    }
    for (const scope of scopes) this.batchOperations.set(scope, operation);
    const write: FacilitatorEvmSigner["writeContract"] = args => {
      operation.broadcastStarted = true;
      return this.signer.writeContract(args);
    };
    const wait: FacilitatorEvmSigner["waitForTransactionReceipt"] = async args => {
      const receipt = await this.signer.waitForTransactionReceipt(args);
      if (!receipt || (receipt.status !== "success" && receipt.status !== "reverted")) {
        throw new Error("transaction receipt status is unknown");
      }
      const observedHash = (receipt as { transactionHash?: unknown }).transactionHash;
      if (
        observedHash !== undefined &&
        (typeof observedHash !== "string" || observedHash.toLowerCase() !== args.hash.toLowerCase())
      ) {
        throw new Error("transaction receipt belongs to another hash");
      }
      return receipt;
    };
    // Bind original methods so prototype-backed signers keep their actual account state.
    const signer = new Proxy(this.signer, {
      get(target, key) {
        if (key === "writeContract") return write;
        if (key === "waitForTransactionReceipt") return wait;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const flight = Promise.resolve().then(async () => {
      const result = await execute(signer, operation);
      const unknownBroadcast = operation.broadcastStarted && !operation.confirm;
      if (unknownBroadcast) {
        return {
          success: false,
          errorReason: ErrSettlementPending,
          errorMessage: result.errorMessage ?? "broadcast returned no usable transaction hash",
          transaction: operation.transaction ?? "",
          network: operation.network,
        };
      }
      if (result.errorReason !== ErrSettlementPending) {
        for (const scope of scopes) {
          if (this.batchOperations.get(scope) === operation) this.batchOperations.delete(scope);
        }
      }
      return result;
    });
    operation.flight = flight;
    try {
      return await flight;
    } catch (error) {
      if (!operation.broadcastStarted) {
        for (const scope of scopes) {
          if (this.batchOperations.get(scope) === operation) this.batchOperations.delete(scope);
        }
      }
      throw error;
    } finally {
      operation.flight = undefined;
    }
  }
}
