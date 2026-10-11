import { SettleResponse, PaymentRequirements } from "@x402/core/types";
import { encodeFunctionData, getAddress } from "viem";
import { FacilitatorEvmSigner } from "../../signer";
import type {
  AuthorizerSigner,
  BatchSettlementEnrichedRefundPayload,
  ChannelState,
} from "../types";
import { batchSettlementABI } from "../abi";
import {
  BATCH_SETTLEMENT_ADDRESS,
  CHANNEL_STATE_POLL_MS,
  CHANNEL_STATE_POLL_INTERVAL_MS,
} from "../constants";
import { computeChannelId } from "../utils";
import { signClaimBatch, signRefund } from "../authorizerSigner";
import * as Errors from "../errors";
import { isValidTxHash, truncateErrorMessage } from "../../utils";
import { waitAndReturnSettleResponse } from "../../shared/settleReceipt";
import { buildVoucherClaimArgs } from "./claim";
import { readChannelState, toContractChannelConfig } from "./utils";
import type { BatchOperation } from "./operation";

type RefundSettlementExtra = {
  channelState: {
    channelId: `0x${string}`;
    balance: string;
    totalClaimed: string;
    withdrawRequestedAt: number;
    refundNonce: string;
  };
};

type RefundSettlementDetails = {
  amount?: string;
  extra: RefundSettlementExtra;
};

/**
 * Amount the server admitted for this refund, including a clamped partial request.
 *
 * @param payload - Refund payload, with `effectiveAmount` when the server clamped it
 * @returns Decimal token amount that settlement and signing must use
 */
function admittedWireAmount(payload: BatchSettlementEnrichedRefundPayload): string {
  const candidate = payload.effectiveAmount ?? payload.amount;
  return /^\d+$/.test(candidate) ? candidate : payload.amount;
}

/**
 * Highest post-claim total for the refunded channel. Other channels in the batch do not apply.
 *
 * @param claims - Bundled claims, in any order
 * @param channelId - Channel whose refund amount is being computed
 * @param network - Network used to derive each claim's channel id
 * @param preTotalClaimed - Claimed total already recorded for this channel
 * @returns Claimed total after this channel's own claims
 */
function scopedPostClaimTotal(
  claims: BatchSettlementEnrichedRefundPayload["claims"],
  channelId: `0x${string}`,
  network: string,
  preTotalClaimed: bigint,
): bigint {
  return claims.reduce((max, claim) => {
    const claimChannelId = computeChannelId(claim.voucher.channel, network);
    if (claimChannelId.toLowerCase() !== channelId.toLowerCase()) {
      return max;
    }
    const totalClaimed = BigInt(claim.totalClaimed);
    return totalClaimed > max ? totalClaimed : max;
  }, preTotalClaimed);
}

/**
 * Computes the token amount that `refundWithSignature` would transfer after any
 * bundled claims are applied.
 *
 * @param payload - Refund payload containing requested refund amount and claims.
 * @param preState - Onchain channel state before the refund transaction.
 * @param channelId - Channel being refunded.
 * @param network - Network identifier used to compute claim channel ids.
 * @returns Refund amount if it can be determined, or `null` when claim data should be left to simulation.
 */
function getRefundableAmount(
  payload: BatchSettlementEnrichedRefundPayload,
  preState: ChannelState,
  channelId: `0x${string}`,
  network: string,
): bigint | null {
  const postClaimTotalClaimed = scopedPostClaimTotal(
    payload.claims,
    channelId,
    network,
    preState.totalClaimed,
  );

  if (postClaimTotalClaimed > preState.balance) {
    return null;
  }

  const requestedAmount = BigInt(admittedWireAmount(payload));
  if (requestedAmount === 0n) {
    return null;
  }

  const available = preState.balance - postClaimTotalClaimed;
  return requestedAmount > available ? available : requestedAmount;
}

/**
 * Builds facilitator-owned response details for a refund settlement after applying the refund amount.
 *
 * @param payload - Refund payload containing claims and amount.
 * @param channelId - Canonical channel id for the refund.
 * @param preState - Onchain channel state before this refund, or null if unknown.
 * @param network - Network used to ignore claims for other channels.
 * @returns Actual refund amount and extra fields for the settlement response.
 */
function buildRefundExtra(
  payload: BatchSettlementEnrichedRefundPayload,
  channelId: `0x${string}`,
  preState: ChannelState | null,
  network: string,
): RefundSettlementDetails {
  const preTotalClaimed = preState?.totalClaimed ?? 0n;
  const preBalance = preState?.balance ?? 0n;
  const postClaimTotalClaimed = scopedPostClaimTotal(
    payload.claims,
    channelId,
    network,
    preTotalClaimed,
  );
  const refundNonce = String((preState?.refundNonce ?? 0n) + 1n);
  if (postClaimTotalClaimed > preBalance) {
    return {
      extra: {
        channelState: {
          channelId,
          balance: preBalance.toString(),
          totalClaimed: preTotalClaimed.toString(),
          withdrawRequestedAt: 0,
          refundNonce,
        },
      },
    };
  }

  const available = preBalance - postClaimTotalClaimed;
  const requestedAmount = BigInt(admittedWireAmount(payload));
  const actualRefund = requestedAmount > available ? available : requestedAmount;

  return {
    amount: actualRefund.toString(),
    extra: {
      channelState: {
        channelId,
        balance: (preBalance - actualRefund).toString(),
        totalClaimed: postClaimTotalClaimed.toString(),
        withdrawRequestedAt: 0,
        refundNonce,
      },
    },
  };
}

/**
 * Reads the post-refund state when pending withdrawal state can be affected.
 *
 * @param signer - Facilitator signer used for onchain reads.
 * @param channelId - Channel that was refunded.
 * @param submittedNonce - Nonce used for this refund transaction.
 * @returns Fresh channel state once the nonce advances, or `null` if RPC reads lag.
 */
async function readPostRefundState(
  signer: FacilitatorEvmSigner,
  channelId: `0x${string}`,
  submittedNonce: string,
): Promise<ChannelState | null> {
  const expectedNonce = BigInt(submittedNonce) + 1n;
  const deadline = Date.now() + CHANNEL_STATE_POLL_MS;

  do {
    let state: ChannelState;
    try {
      state = await readChannelState(signer, channelId);
    } catch {
      return null;
    }
    if (state.refundNonce >= expectedNonce) {
      return state;
    }
    await new Promise(resolve => setTimeout(resolve, CHANNEL_STATE_POLL_INTERVAL_MS));
  } while (Date.now() < deadline);

  return null;
}

/**
 * Builds refund response details from confirmed post-transaction state.
 *
 * @param channelId - Canonical channel id for the refund.
 * @param preState - Onchain state read before the transaction.
 * @param postState - Onchain state after the transaction.
 * @returns Actual refund amount and extra fields for the settlement response.
 */
function buildRefundExtraFromPostState(
  channelId: `0x${string}`,
  preState: ChannelState,
  postState: ChannelState,
): RefundSettlementDetails {
  const actualRefund =
    preState.balance > postState.balance ? preState.balance - postState.balance : 0n;

  return {
    amount: actualRefund.toString(),
    extra: {
      channelState: {
        channelId,
        balance: postState.balance.toString(),
        totalClaimed: postState.totalClaimed.toString(),
        withdrawRequestedAt: postState.withdrawRequestedAt,
        refundNonce: postState.refundNonce.toString(),
      },
    },
  };
}

/**
 * Executes a cooperative refund via `refundWithSignature`.
 *
 * When `refundAuthorizerSignature` / `claimAuthorizerSignature` are present they are used
 * directly.  When absent the facilitator signs the missing digests using
 * `authorizerSigner`, after verifying that `config.receiverAuthorizer` matches
 * `authorizerSigner.address`.
 *
 * If `payload.claims` is non-empty, the claim and refund are batched atomically via
 * the contract's `multicall`.
 *
 * @param signer - Facilitator signer used to submit the onchain transactions.
 * @param payload - Refund payload with optional signatures, amount, and nonce.
 * @param requirements - Payment requirements for network identification.
 * @param authorizerSigner - Optional dedicated key for producing EIP-712 signatures.
 *   When omitted, the payload must already carry the required authorizer signatures.
 * @param dataSuffix - Optional hex suffix appended to the refund transaction.
 * @param operation - Instance-owned continuation for exact pending retries.
 * @returns A {@link SettleResponse} with the transaction hash on success.
 */
export async function executeRefundWithSignature(
  signer: FacilitatorEvmSigner,
  payload: BatchSettlementEnrichedRefundPayload,
  requirements: PaymentRequirements,
  authorizerSigner: AuthorizerSigner | undefined,
  dataSuffix?: `0x${string}`,
  operation?: BatchOperation,
): Promise<SettleResponse> {
  if (operation?.confirm) return operation.confirm();
  payload = structuredClone(payload);
  const network = requirements.network;
  const signedAmount = admittedWireAmount(payload);

  try {
    const channelId = computeChannelId(payload.channelConfig, network);
    const preState = await readChannelState(signer, channelId);
    const contractAddr = getAddress(BATCH_SETTLEMENT_ADDRESS);
    const refundableAmount = getRefundableAmount(payload, preState, channelId, network);

    if (refundableAmount === 0n) {
      return {
        success: false,
        errorReason: Errors.ErrRefundNoBalance,
        errorMessage: "Nothing to refund",
        transaction: "",
        network,
      };
    }

    const hasClientSig = payload.refundAuthorizerSignature !== undefined;

    if (!hasClientSig && !authorizerSigner) {
      return {
        success: false,
        errorReason: Errors.ErrAuthorizerNotConfigured,
        transaction: "",
        network,
      };
    }

    if (
      !hasClientSig &&
      authorizerSigner &&
      getAddress(payload.channelConfig.receiverAuthorizer) !== getAddress(authorizerSigner.address)
    ) {
      return {
        success: false,
        errorReason: Errors.ErrAuthorizerAddressMismatch,
        transaction: "",
        network,
      };
    }

    const refundSig =
      payload.refundAuthorizerSignature ??
      (await signRefund(authorizerSigner!, channelId, signedAmount, payload.refundNonce, network));

    const refundCalldata = encodeFunctionData({
      abi: batchSettlementABI,
      functionName: "refundWithSignature",
      args: [
        toContractChannelConfig(payload.channelConfig),
        BigInt(signedAmount),
        BigInt(payload.refundNonce),
        refundSig,
      ],
    });

    let tx: `0x${string}`;

    if (payload.claims.length > 0) {
      let claimSig = payload.claimAuthorizerSignature;
      if (!claimSig) {
        if (!authorizerSigner) {
          return {
            success: false,
            errorReason: Errors.ErrAuthorizerNotConfigured,
            transaction: "",
            network,
          };
        }
        claimSig = await signClaimBatch(authorizerSigner, payload.claims, network);
      }

      const claimCalldata = encodeFunctionData({
        abi: batchSettlementABI,
        functionName: "claimWithSignature",
        args: [buildVoucherClaimArgs(payload.claims), claimSig],
      });

      try {
        await signer.readContract({
          address: contractAddr,
          abi: batchSettlementABI,
          functionName: "multicall",
          args: [[claimCalldata, refundCalldata]],
        });
      } catch (e) {
        return {
          success: false,
          errorReason: Errors.ErrRefundSimulationFailed,
          errorMessage: e instanceof Error ? e.message : String(e),
          transaction: "",
          network,
        };
      }

      tx = await signer.writeContract({
        address: contractAddr,
        abi: batchSettlementABI,
        functionName: "multicall",
        args: [[claimCalldata, refundCalldata]],
        dataSuffix,
      });
    } else {
      try {
        await signer.readContract({
          address: contractAddr,
          abi: batchSettlementABI,
          functionName: "refundWithSignature",
          args: [
            toContractChannelConfig(payload.channelConfig),
            BigInt(signedAmount),
            BigInt(payload.refundNonce),
            refundSig,
          ],
        });
      } catch (e) {
        return {
          success: false,
          errorReason: Errors.ErrRefundSimulationFailed,
          errorMessage: e instanceof Error ? e.message : String(e),
          transaction: "",
          network,
        };
      }

      tx = await signer.writeContract({
        address: contractAddr,
        abi: batchSettlementABI,
        functionName: "refundWithSignature",
        args: [
          toContractChannelConfig(payload.channelConfig),
          BigInt(signedAmount),
          BigInt(payload.refundNonce),
          refundSig,
        ],
        dataSuffix,
      });
    }

    const confirm = () =>
      waitAndReturnSettleResponse(signer, tx, network, payload.channelConfig.payer, {
        failedStatusReason: Errors.ErrRefundTransactionFailed,
        onSuccess: async () => {
          const postState =
            preState && preState.withdrawRequestedAt !== 0
              ? await readPostRefundState(signer, channelId, payload.refundNonce)
              : null;
          const refundDetails =
            preState && postState
              ? buildRefundExtraFromPostState(channelId, preState, postState)
              : buildRefundExtra(payload, channelId, preState, network);

          return {
            success: true,
            transaction: tx,
            network,
            payer: payload.channelConfig.payer,
            ...(refundDetails.amount !== undefined ? { amount: refundDetails.amount } : {}),
            extra: refundDetails.extra,
          };
        },
      });
    if (operation && isValidTxHash(tx)) {
      operation.transaction = tx;
      operation.confirm = confirm;
    }
    return await confirm();
  } catch (e) {
    return {
      success: false,
      errorReason: Errors.ErrRefundTransactionFailed,
      errorMessage: truncateErrorMessage(e instanceof Error ? e.message : String(e)),
      transaction: "",
      network,
    };
  }
}
