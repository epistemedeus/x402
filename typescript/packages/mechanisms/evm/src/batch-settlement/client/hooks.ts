import type { SchemeClientHooks } from "@x402/core/types";
import {
  isBatchSettlementDepositPayload,
  isBatchSettlementRefundPayload,
  type BatchSettlementChannelStateExtra,
} from "../types";
import { computeChannelId } from "../utils";
import {
  type BatchSettlementClientDeps,
  buildChannelConfig,
  updateChannelAfterRefund,
  updateChannelFromSettle,
} from "./channel";
import { admittedClientRefundAmount } from "./refund";
import { processCorrectivePaymentRequired } from "./recovery";

/**
 * Creates storage-aware client hooks for batch-settlement payment responses.
 *
 * @param deps - Client identity and storage inputs.
 * @returns Scheme hooks for response reconciliation and corrective recovery.
 */
export function createBatchSettlementClientHooks(
  deps: BatchSettlementClientDeps,
): SchemeClientHooks {
  return {
    onPaymentResponse: async ctx => {
      const settleResponse = ctx.settleResponse;
      if (settleResponse) {
        if (!settleResponse.success) {
          return;
        }

        const payload = ctx.paymentPayload.payload;
        const channelId = computeChannelId(
          buildChannelConfig(deps, ctx.requirements),
          ctx.requirements.network,
        );
        if (isBatchSettlementRefundPayload(payload)) {
          if (
            settleResponse.network !== ctx.requirements.network ||
            !/^0x[0-9a-fA-F]{64}$/.test(settleResponse.transaction) ||
            settleResponse.errorReason !== undefined ||
            !/^\d+$/.test(settleResponse.amount ?? "") ||
            BigInt(settleResponse.amount ?? "0") === 0n
          ) {
            throw new Error(
              "Refund outcome unknown: response did not confirm this network, hash, and amount",
            );
          }
          const storageKey = channelId.toLowerCase();
          const stored = await deps.storage.get(storageKey);
          const attempt = deps.refundAttempts?.get(storageKey);
          const admitted = admittedClientRefundAmount(
            payload.amount,
            stored?.balance,
            stored?.chargedCumulativeAmount,
          );
          const effective = attempt?.effectiveAmount ?? admitted.effective;
          const unconstrainedFull =
            attempt?.effectiveAmount === undefined && admitted.unconstrainedFull;
          if (
            !unconstrainedFull &&
            (effective === undefined || settleResponse.amount !== effective)
          ) {
            throw new Error(
              "Refund outcome unknown: response amount is not the admitted refund amount",
            );
          }
          const responsePayer = settleResponse.payer;
          const admittedPayer = attempt?.payer ?? payload.channelConfig.payer;
          if (
            responsePayer !== undefined &&
            admittedPayer !== undefined &&
            responsePayer.toLowerCase() !== admittedPayer.toLowerCase()
          ) {
            throw new Error(
              "Refund outcome unknown: response payer conflicts with the admitted channel",
            );
          }
          const responseChannel = settleResponse.extra?.channelState;
          const responseChannelId =
            responseChannel &&
            typeof responseChannel === "object" &&
            "channelId" in responseChannel &&
            typeof responseChannel.channelId === "string"
              ? responseChannel.channelId
              : undefined;
          if (
            responseChannelId !== undefined &&
            responseChannelId.toLowerCase() !== channelId.toLowerCase()
          ) {
            throw new Error(
              "Refund outcome unknown: response channel conflicts with the admitted channel",
            );
          }
          const responseNonce =
            responseChannel &&
            typeof responseChannel === "object" &&
            "refundNonce" in responseChannel &&
            (typeof responseChannel.refundNonce === "string" ||
              typeof responseChannel.refundNonce === "number")
              ? String(responseChannel.refundNonce)
              : undefined;
          if (attempt?.nonce !== undefined && responseNonce !== undefined) {
            const expectedNonce = (BigInt(attempt.nonce) + 1n).toString();
            if (responseNonce !== expectedNonce) {
              throw new Error(
                "Refund outcome unknown: response nonce is not the admitted refund nonce",
              );
            }
          }
          await updateChannelAfterRefund(
            deps.storage,
            storageKey,
            unconstrainedFull ? undefined : effective,
          );
          return;
        }
        const chargedAmount = settleResponse.extra?.chargedAmount;
        if (chargedAmount !== undefined && typeof chargedAmount !== "string") {
          throw new Error("invalid chargedAmount: not a non-negative integer");
        }
        const channelState = settleResponse.extra?.channelState as
          | BatchSettlementChannelStateExtra
          | undefined;
        await updateChannelFromSettle(deps.storage, {
          server: {
            chargedAmount,
            chargedCumulativeAmount: channelState?.chargedCumulativeAmount,
          },
          local: {
            channelId,
            requestAmount: ctx.requirements.amount,
            depositAmount: isBatchSettlementDepositPayload(payload)
              ? payload.deposit.amount
              : undefined,
          },
        });
        return;
      }

      if (ctx.paymentRequired) {
        const accept = ctx.paymentRequired.accepts.find(
          option => option.scheme === ctx.requirements.scheme,
        );
        if (accept) {
          try {
            const recoveryKey = computeChannelId(
              buildChannelConfig(deps, accept),
              accept.network,
            ).toLowerCase();
            const pending = deps.refundAttempts?.get(recoveryKey);
            if (pending?.unknown || pending?.transaction) {
              return;
            }
          } catch {
            // A requirements shape that cannot name a channel keeps the existing recovery path.
          }
        }
        const recovered = await processCorrectivePaymentRequired(deps, ctx.paymentRequired);
        return recovered ? { recovered: true } : undefined;
      }
    },
  };
}
