import { SettleError, type SettleResponse } from "@x402/core/types";
import type { SettleContext, SettleFailureContext, SettleResultContext } from "@x402/core/server";
import { signClaimBatch, signRefund } from "../authorizerSigner";
import {
  isBatchSettlementDepositPayload,
  isBatchSettlementRefundPayload,
  isBatchSettlementVoucherPayload,
} from "../types";
import type { BatchSettlementPaymentResponseExtra, BatchSettlementVoucherClaim } from "../types";
import { computeChannelId, sameAssertedTransactionHash } from "../utils";
import * as Errors from "../errors";
import type { SettlementResultAcceptance } from "@x402/core/server";
import type { BatchSettlementEvmScheme } from "./scheme";
import type { Channel } from "./storage";
import {
  parseRefundSettlementSnapshot,
  readChannelStateExtra,
  readExtraNumber,
  readExtraString,
} from "./utils";

/**
 * Reports why a positive settle response is not the admitted refund effect.
 * Absent channel state does not invent an amount. Present payer, channel, nonce,
 * and balance evidence must match the frozen operation.
 *
 * @param response - Facilitator settle response
 * @param expected - Admitted network, amount, and optional channel evidence
 * @param expected.network - Network that admitted the operation
 * @param expected.effectiveAmount - Exact amount the server signed, when known
 * @param expected.payer - Admitted payer, checked only when the response names one
 * @param expected.channelId - Admitted channel id
 * @param expected.originalNonce - Refund nonce before this operation
 * @param expected.previousBalance - Balance before this operation
 * @param expected.originalTransaction - Hash already bound to this operation, if any
 * @returns A stable mismatch description, or undefined when the response confirms the effect
 */
export function refundEffectMismatch(
  response: SettleResponse,
  expected: {
    network: string;
    effectiveAmount?: string;
    payer?: string;
    channelId?: string;
    originalNonce?: string;
    previousBalance?: string;
    originalTransaction?: string;
  },
): string | undefined {
  if (response.network !== expected.network) {
    return "response network does not match the admitted operation";
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(response.transaction)) {
    return "response did not confirm the original transaction hash";
  }
  if (
    expected.originalTransaction !== undefined &&
    expected.originalTransaction.toLowerCase() !== response.transaction.toLowerCase()
  ) {
    return "response names a different original transaction";
  }
  if (response.errorReason !== undefined) {
    return "response carried an error after reporting success";
  }
  if (
    expected.effectiveAmount === undefined ||
    !/^\d+$/.test(expected.effectiveAmount) ||
    BigInt(expected.effectiveAmount) === 0n
  ) {
    return "admitted refund amount is missing";
  }
  if (response.amount !== expected.effectiveAmount) {
    return "response amount is not the admitted refund amount";
  }
  if (
    response.payer !== undefined &&
    expected.payer !== undefined &&
    response.payer.toLowerCase() !== expected.payer.toLowerCase()
  ) {
    return "response payer conflicts with the admitted channel";
  }
  const state = readChannelStateExtra(response.extra);
  if (!state) {
    return undefined;
  }
  if (
    expected.channelId !== undefined &&
    state.channelId !== undefined &&
    String(state.channelId).toLowerCase() !== expected.channelId.toLowerCase()
  ) {
    return "response channel conflicts with the admitted channel";
  }
  if (expected.originalNonce !== undefined && state.refundNonce !== undefined) {
    const expectedNonce = (BigInt(expected.originalNonce) + 1n).toString();
    if (String(state.refundNonce) !== expectedNonce) {
      return "response nonce is not the admitted refund nonce";
    }
  }
  if (expected.previousBalance !== undefined && state.balance !== undefined) {
    const expectedBalance = (
      BigInt(expected.previousBalance) - BigInt(expected.effectiveAmount)
    ).toString();
    if (String(state.balance) !== expectedBalance) {
      return "response balance is not the admitted refund effect";
    }
  }
  return undefined;
}

/**
 * Converts stored channel state into the public response snapshot shape.
 *
 * @param channel - Stored channel state.
 * @param chargedCumulativeAmount - Optional current charged cumulative amount.
 * @returns Response-ready channel snapshot.
 */
function channelStateExtra(
  channel: Pick<
    Channel,
    "channelId" | "balance" | "totalClaimed" | "withdrawRequestedAt" | "refundNonce"
  >,
  chargedCumulativeAmount?: string,
): NonNullable<BatchSettlementPaymentResponseExtra["channelState"]> {
  return {
    channelId: channel.channelId as `0x${string}`,
    balance: channel.balance,
    totalClaimed: channel.totalClaimed,
    withdrawRequestedAt: channel.withdrawRequestedAt,
    refundNonce: String(channel.refundNonce),
    ...(chargedCumulativeAmount !== undefined ? { chargedCumulativeAmount } : {}),
  };
}

/**
 * Lifecycle hook: runs before the facilitator settles a payment.
 *
 * For voucher payloads the server does NOT trigger an onchain settle.  Instead, it
 * increments the local `chargedCumulativeAmount` and returns a `skip` result so the
 * middleware responds immediately. Cooperative refund payloads proceed to settlement
 * enrichment before facilitator settlement.
 *
 * @param scheme - Owning `BatchSettlementEvmScheme` instance for storage access.
 * @param ctx - Settle lifecycle context (payload and requirements).
 * @returns Nothing to proceed; `abort` to fail; `skip` with a result to short-circuit settlement.
 */
export async function handleBeforeSettle(
  scheme: BatchSettlementEvmScheme,
  ctx: SettleContext,
): Promise<
  void | { abort: true; reason: string; message?: string } | { skip: true; result: SettleResponse }
> {
  const { paymentPayload, requirements } = ctx;

  const raw = paymentPayload.payload;
  const storage = scheme.getStorage();

  if (!isBatchSettlementVoucherPayload(raw)) {
    return;
  }

  const { voucher } = raw;
  const channelId = voucher.channelId;
  const pendingId = scheme.readRequestContext(paymentPayload)?.pendingId;

  const increment = BigInt(requirements.amount);
  const signedCap = BigInt(voucher.maxClaimableAmount);
  let outcome:
    | { status: "missing" }
    | { status: "pending_mismatch" }
    | { status: "cap_exceeded"; charged: string }
    | { status: "committed"; previous: Channel; current: Channel }
    | undefined;

  const updateResult = await storage.updateChannel(channelId, current => {
    if (!current) {
      outcome = { status: "missing" };
      return current;
    }

    if (!pendingId || current.pendingRequest?.pendingId !== pendingId) {
      outcome = { status: "pending_mismatch" };
      return current;
    }

    const newCharged = BigInt(current.chargedCumulativeAmount) + increment;
    if (newCharged > signedCap) {
      outcome = { status: "cap_exceeded", charged: newCharged.toString() };
      return {
        ...current,
        pendingRequest: undefined,
      };
    }

    const updatedChannel: Channel = {
      ...current,
      chargedCumulativeAmount: newCharged.toString(),
      signedMaxClaimable: voucher.maxClaimableAmount,
      signature: voucher.signature,
      lastRequestTimestamp: Date.now(),
      pendingRequest: undefined,
    };
    outcome = { status: "committed", previous: current, current: updatedChannel };
    return updatedChannel;
  });

  if (outcome?.status === "missing") {
    scheme.takeRequestContext(paymentPayload);
    return {
      abort: true,
      reason: Errors.ErrMissingChannel,
      message: "No channel record",
    };
  }

  if (outcome?.status === "cap_exceeded") {
    scheme.takeRequestContext(paymentPayload);
    return {
      abort: true,
      reason: Errors.ErrChargeExceedsSignedCumulative,
      message: `Charged ${outcome.charged} exceeds signed max ${signedCap.toString()}`,
    };
  }

  if (updateResult.status !== "updated" || outcome?.status !== "committed") {
    scheme.takeRequestContext(paymentPayload);
    return {
      abort: true,
      reason: Errors.ErrChannelBusy,
      message: "Concurrent request modified channel state",
    };
  }
  scheme.takeRequestContext(paymentPayload);

  const skipExtra: BatchSettlementPaymentResponseExtra = {
    channelState: channelStateExtra(outcome.previous, outcome.current.chargedCumulativeAmount),
    chargedAmount: requirements.amount,
  };

  return {
    skip: true,
    result: {
      success: true,
      payer: outcome.previous.channelConfig.payer.toLowerCase() as `0x${string}`,
      transaction: "",
      network: requirements.network,
      amount: "",
      extra: skipExtra,
    },
  };
}

/**
 * Enriches cooperative refund vouchers with facilitator settlement fields.
 *
 * @param scheme - Owning `BatchSettlementEvmScheme` instance for storage and signer access.
 * @param ctx - Settlement context for the current payment.
 * @returns Additive refund settlement fields, or nothing for non-refund payloads.
 */
export async function handleEnrichSettlementPayload(
  scheme: BatchSettlementEvmScheme,
  ctx: SettleContext,
): Promise<Record<string, unknown> | void> {
  const { paymentPayload, requirements } = ctx;
  const raw = paymentPayload.payload;
  if (!isBatchSettlementRefundPayload(raw)) {
    return;
  }

  const channelId = computeChannelId(raw.channelConfig, requirements.network);
  if (raw.voucher.channelId !== channelId) {
    throw new Error("refund channelId does not match channelConfig");
  }

  const channel = await scheme.getStorage().get(channelId);
  if (!channel) {
    throw new Error(Errors.ErrMissingChannel);
  }
  const pendingId = scheme.readRequestContext(paymentPayload)?.pendingId;
  if (!pendingId || channel.pendingRequest?.pendingId !== pendingId) {
    throw new Error(Errors.ErrChannelBusy);
  }
  if (BigInt(raw.voucher.maxClaimableAmount) !== BigInt(channel.chargedCumulativeAmount)) {
    throw new Error(Errors.ErrCumulativeAmountMismatch);
  }
  if (raw.voucher.signature !== channel.signature) {
    throw new Error(Errors.ErrInvalidVoucherSignature);
  }

  const request = scheme.readRequestContext(paymentPayload);
  const retained = scheme.readRetainedRefund(channelId);
  if (retained) {
    if (
      request?.refundBinding !== retained.binding ||
      request.refundGeneration !== retained.generation
    ) {
      throw new Error(Errors.ErrChannelBusy);
    }
    scheme.rememberChannelSnapshot(paymentPayload, channel);
    return retained.enrichment;
  }

  const config = raw.channelConfig;

  const claimEntry: BatchSettlementVoucherClaim = {
    voucher: {
      channel: config,
      maxClaimableAmount: raw.voucher.maxClaimableAmount,
    },
    signature: raw.voucher.signature,
    totalClaimed: channel.chargedCumulativeAmount,
  };

  const remainder = BigInt(channel.balance) - BigInt(channel.chargedCumulativeAmount);
  if (remainder <= 0n) {
    throw new Error(Errors.ErrRefundNoBalance);
  }

  let requested = remainder;
  if (raw.amount !== undefined) {
    if (!/^\d+$/.test(raw.amount)) {
      throw new Error(Errors.ErrRefundAmountInvalid);
    }
    const requestedAmount = BigInt(raw.amount);
    if (requestedAmount <= 0n) {
      throw new Error(Errors.ErrRefundAmountInvalid);
    }
    requested = requestedAmount;
  }
  const refundAmountBig = requested > remainder ? remainder : requested;
  if (refundAmountBig <= 0n) {
    throw new Error(Errors.ErrRefundNoBalance);
  }

  const refundAmount = refundAmountBig.toString();
  const nonce = String(channel.refundNonce ?? 0);

  const receiverAuthorizerSigner = scheme.getReceiverAuthorizerSigner();

  const refundAuthorizerSignature = receiverAuthorizerSigner
    ? await signRefund(
        receiverAuthorizerSigner,
        channelId as `0x${string}`,
        refundAmount,
        nonce,
        requirements.network,
      )
    : undefined;

  const claimAuthorizerSignature = receiverAuthorizerSigner
    ? await signClaimBatch(receiverAuthorizerSigner, [claimEntry], requirements.network)
    : undefined;

  scheme.rememberChannelSnapshot(paymentPayload, channel);

  const enrichment = {
    ...(raw.amount === undefined ? { amount: refundAmount } : {}),
    effectiveAmount: refundAmount,
    refundNonce: nonce,
    claims: [claimEntry],
    refundAuthorizerSignature,
    claimAuthorizerSignature,
  };
  if (request?.refundBinding && request.refundVerification) {
    const refundGeneration = scheme.retainRefund(channelId, {
      binding: request.refundBinding,
      verification: request.refundVerification,
      enrichment,
      effectiveAmount: refundAmount,
      payer: channel.channelConfig.payer,
      nonce,
    });
    scheme.mergeRequestContext(paymentPayload, { refundGeneration });
  }
  return enrichment;
}

/**
 * Accepts a refund settle result before ordinary observers run.
 * Vouchers and deposits return void so their existing hooks stay observational.
 *
 * @param scheme - Owning scheme
 * @param ctx - Successful facilitator or skipped settle result
 * @returns Accepted, unresolved with the original retry identity, or void for other payload types
 */
export async function handleAcceptSettlementResult(
  scheme: BatchSettlementEvmScheme,
  ctx: SettleResultContext,
): Promise<SettlementResultAcceptance | void> {
  const raw = ctx.paymentPayload.payload;
  if (!isBatchSettlementRefundPayload(raw)) {
    return;
  }
  try {
    await handleAfterSettle(scheme, ctx);
    scheme.mergeRequestContext(ctx.paymentPayload, { refundReconciled: true });
    return { outcome: "accepted" };
  } catch (error) {
    const request = scheme.readRequestContext(ctx.paymentPayload);
    const retained = scheme.readRetainedRefund(
      computeChannelId(raw.channelConfig, ctx.requirements.network),
    );
    const asserted =
      ctx.result.network === ctx.requirements.network &&
      /^0x[0-9a-fA-F]{64}$/.test(ctx.result.transaction)
        ? ctx.result.transaction
        : "";
    const transaction =
      retained?.transaction !== undefined && /^0x[0-9a-fA-F]{64}$/.test(retained.transaction)
        ? retained.transaction
        : asserted;
    return {
      outcome: "unresolved",
      reason: error instanceof Error ? error.message : String(error),
      retry: {
        network: ctx.requirements.network,
        transaction,
        ...(request?.refundBinding !== undefined ? { binding: request.refundBinding } : {}),
      },
    };
  }
}

/**
 * Lifecycle hook: runs after the facilitator settles a payment.
 *
 * Updates channel state to reflect the settlement outcome — adjusting charged amounts,
 * balances, and handling cooperative-refund cleanup (channel record deletion).
 *
 * @param scheme - Owning `BatchSettlementEvmScheme` instance for storage access.
 * @param ctx - Post-settle lifecycle context.
 * @param ctx.paymentPayload - Payment payload that was settled (possibly rewritten).
 * @param ctx.requirements - Requirements used for settlement.
 * @param ctx.result - Facilitator settle response.
 * @returns Resolves when session updates are complete (no return value).
 */
export async function handleAfterSettle(
  scheme: BatchSettlementEvmScheme,
  ctx: SettleResultContext,
): Promise<void> {
  const { paymentPayload, requirements, result } = ctx;
  if (!result.success) {
    return;
  }

  const raw = paymentPayload.payload;
  const storage = scheme.getStorage();

  if (isBatchSettlementRefundPayload(raw)) {
    if (scheme.readRequestContext(paymentPayload)?.refundReconciled) {
      return;
    }
    const channelId = computeChannelId(raw.channelConfig, requirements.network);
    const retained = scheme.readRetainedRefund(channelId);
    const request = scheme.readRequestContext(paymentPayload);
    if (retained) {
      const owns =
        request?.refundBinding === retained.binding &&
        request?.refundGeneration === retained.generation;
      if (!owns) {
        throw new Error(Errors.ErrChannelBusy);
      }
      const channel = await storage.get(channelId);
      const mismatch = refundEffectMismatch(result, {
        network: requirements.network,
        effectiveAmount: retained.effectiveAmount,
        payer: retained.payer ?? channel?.channelConfig.payer,
        channelId,
        originalNonce: retained.nonce ?? String(channel?.refundNonce ?? 0),
        previousBalance: channel?.balance,
        originalTransaction: retained.transaction,
      });
      if (mismatch) {
        scheme.markRefundUnresolved(
          channelId,
          request?.refundBinding,
          request?.refundGeneration,
          result.network === requirements.network && /^0x[0-9a-fA-F]{64}$/.test(result.transaction)
            ? result.transaction
            : undefined,
        );
        throw new Error(`Refund outcome unknown: ${mismatch}`);
      }
    }
    const pendingId = scheme.readRequestContext(paymentPayload)?.pendingId;
    const now = Date.now();

    let updateResult;
    try {
      const snapshot = parseRefundSettlementSnapshot(result.extra);
      updateResult = await storage.updateChannel(channelId, current => {
        if (!current) {
          return current;
        }
        if (!pendingId || current.pendingRequest?.pendingId !== pendingId) {
          return current;
        }
        if (BigInt(snapshot.balance) <= BigInt(current.chargedCumulativeAmount)) {
          return undefined;
        }
        return {
          ...current,
          ...snapshot,
          onchainSyncedAt: now,
          lastRequestTimestamp: now,
          pendingRequest: undefined,
        };
      });
    } catch (error) {
      if (retained) {
        scheme.markRefundUnresolved(
          channelId,
          request?.refundBinding,
          request?.refundGeneration,
          /^0x[0-9a-fA-F]{64}$/.test(result.transaction) ? result.transaction : undefined,
        );
      }
      throw error;
    }
    if (updateResult.status === "unchanged") {
      if (retained) {
        scheme.markRefundUnresolved(
          channelId,
          request?.refundBinding,
          request?.refundGeneration,
          /^0x[0-9a-fA-F]{64}$/.test(result.transaction) ? result.transaction : undefined,
        );
        throw new Error("Refund outcome unknown: storage did not reconcile the owning generation");
      }
      throw new Error(Errors.ErrChannelBusy);
    }
    scheme.releaseRetainedRefund(
      channelId,
      scheme.readRequestContext(paymentPayload)?.refundBinding,
      scheme.readRequestContext(paymentPayload)?.refundGeneration,
    );
    return;
  }

  if (isBatchSettlementVoucherPayload(raw)) {
    return;
  }

  if (isBatchSettlementDepositPayload(raw)) {
    const channelId = raw.voucher.channelId;
    const pendingId = scheme.readRequestContext(paymentPayload)?.pendingId;
    const ex = result.extra ?? {};
    const channelState = readChannelStateExtra(ex);
    const config = raw.channelConfig;
    const signedMaxClaimable = raw.voucher.maxClaimableAmount;
    const now = Date.now();

    const updateResult = await storage.updateChannel(channelId, current => {
      if (!current) {
        return current;
      }
      if (!pendingId || current.pendingRequest?.pendingId !== pendingId) {
        return current;
      }
      const chargedActual = (
        BigInt(current.chargedCumulativeAmount) + BigInt(requirements.amount)
      ).toString();
      return {
        channelId,
        channelConfig: config,
        chargedCumulativeAmount: chargedActual,
        signedMaxClaimable,
        signature: raw.voucher.signature,
        balance: readExtraString(channelState, "balance", current.balance),
        totalClaimed: readExtraString(channelState, "totalClaimed", current.totalClaimed),
        withdrawRequestedAt: readExtraNumber(
          channelState,
          "withdrawRequestedAt",
          current.withdrawRequestedAt,
        ),
        refundNonce: readExtraNumber(channelState, "refundNonce", current.refundNonce),
        onchainSyncedAt: now,
        lastRequestTimestamp: now,
      };
    });
    if (updateResult.status === "updated" && updateResult.channel) {
      scheme.rememberChannelSnapshot(paymentPayload, updateResult.channel);
      return;
    }
    scheme.takeRequestContext(paymentPayload);
    throw new Error(Errors.ErrChannelBusy);
  }
}

/**
 * Cleanup hook: clears this request's reservation after settlement throws.
 *
 * @param scheme - Owning `BatchSettlementEvmScheme` instance.
 * @param ctx - Settle failure context for the current payment.
 */
export async function handleSettleFailure(
  scheme: BatchSettlementEvmScheme,
  ctx: SettleFailureContext,
): Promise<void> {
  const request = scheme.readRequestContext(ctx.paymentPayload);
  const error = ctx.error;
  const knownRefusal =
    error instanceof SettleError &&
    error.network === ctx.requirements.network &&
    error.transaction === "" &&
    [
      Errors.ErrRefundNoBalance,
      Errors.ErrRefundSimulationFailed,
      Errors.ErrAuthorizerNotConfigured,
      Errors.ErrAuthorizerAddressMismatch,
      Errors.ErrReceiverMismatch,
      Errors.ErrTokenMismatch,
      Errors.ErrNetworkMismatch,
      Errors.ErrChannelIdMismatch,
      Errors.ErrRefundAmountInvalid,
    ].includes(error.errorReason ?? "");
  const confirmedRevert =
    error instanceof SettleError &&
    error.network === ctx.requirements.network &&
    /^0x[0-9a-fA-F]{64}$/.test(error.transaction) &&
    error.errorReason === Errors.ErrRefundTransactionFailed;
  if (request?.channelId) {
    const retained = scheme.readRetainedRefund(request.channelId);
    const receivedOriginalRevert =
      confirmedRevert &&
      (!retained?.unresolved ||
        sameAssertedTransactionHash(retained.transaction, (error as SettleError).transaction));
    if ((knownRefusal && !retained?.unresolved) || receivedOriginalRevert) {
      scheme.releaseRetainedRefund(
        request.channelId,
        request.refundBinding,
        request.refundGeneration,
      );
    } else {
      const transaction =
        error instanceof SettleError &&
        error.network === ctx.requirements.network &&
        /^0x[0-9a-fA-F]{64}$/.test(error.transaction)
          ? error.transaction
          : undefined;
      scheme.markRefundUnresolved(
        request.channelId,
        request.refundBinding,
        request.refundGeneration,
        transaction,
      );
    }
  }
  // Pending, foreign, malformed, and transport-unknown outcomes retain the
  // original binding and signatures even when the short request reservation ends.
  await scheme.clearPendingRequest(ctx.paymentPayload);
}

/**
 * Supplies server-owned settlement response fields from the channel snapshot.
 *
 * @param scheme - Owning `BatchSettlementEvmScheme` instance for snapshot access.
 * @param ctx - Settlement result context for the current payment.
 * @returns Additive response extra fields, or nothing when no snapshot exists.
 */
export async function handleEnrichSettlementResponse(
  scheme: BatchSettlementEvmScheme,
  ctx: SettleResultContext,
): Promise<Record<string, unknown> | void> {
  const raw = ctx.paymentPayload.payload;
  if (isBatchSettlementVoucherPayload(raw)) {
    return;
  }

  if (isBatchSettlementRefundPayload(raw) && scheme.readRetainedRefund(raw.voucher.channelId)) {
    // Core logs hook errors. Preserve this unknown operation and its context;
    // the SDK refund consumer independently refuses malformed success assertions.
    const request = scheme.readRequestContext(ctx.paymentPayload);
    scheme.markRefundUnresolved(
      raw.voucher.channelId,
      request?.refundBinding,
      request?.refundGeneration,
      ctx.result.network === ctx.requirements.network &&
        /^0x[0-9a-fA-F]{64}$/.test(ctx.result.transaction)
        ? ctx.result.transaction
        : undefined,
    );
    throw new Error(
      "Refund outcome unknown: original admitted operation was not confirmed in local storage",
    );
  }
  const channel = scheme.takeChannelSnapshot(ctx.paymentPayload);
  if (!channel) {
    return;
  }

  if (isBatchSettlementRefundPayload(raw)) {
    return {
      channelState: {
        chargedCumulativeAmount: channel.chargedCumulativeAmount,
      },
    };
  }

  if (isBatchSettlementDepositPayload(raw)) {
    return {
      channelState: {
        chargedCumulativeAmount: channel.chargedCumulativeAmount,
      },
      chargedAmount: ctx.requirements.amount,
    };
  }
  return {
    channelState: {
      chargedCumulativeAmount: channel.chargedCumulativeAmount,
    },
  };
}
