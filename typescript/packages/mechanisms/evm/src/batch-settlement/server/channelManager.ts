import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
} from "@x402/core/types";
import type { FacilitatorClient } from "@x402/core/server";
import { getAddress } from "viem";
import type { BatchSettlementVoucherClaim } from "../types";
import type { BatchSettlementEvmScheme } from "./scheme";
import { computeChannelId } from "../utils";
import { BATCH_SETTLEMENT_SCHEME } from "../constants";
import { ErrNothingToSettle } from "../errors";
import { signClaimBatch, signRefund } from "../authorizerSigner";
import { isChannelAdmissionLive, type Channel } from "./storage";
import { refundEffectMismatch } from "./settle";
import {
  assertReceiverSettlementTotals,
  unsignedEip155ChainId,
  type ReadReceiverSettlement,
  type ReceiverSettlementSnapshot,
} from "./receiverState";

export interface ChannelManagerConfig {
  scheme: BatchSettlementEvmScheme;
  facilitator: FacilitatorClient;
  receiver: `0x${string}`;
  token: `0x${string}`;
  network: Network;
  /**
   * Reads `receivers(payTo, token)` for this manager's network.
   * Required to settle a refund whose claim was submitted outside this process.
   * Absent readers keep the process-local hint and cannot see those claims.
   */
  readReceiverSettlement?: ReadReceiverSettlement;
}

export type ClaimChannelSelector = (
  channels: Channel[],
  context: AutoSettlementContext,
) => Channel[] | Promise<Channel[]>;

export interface ClaimOptions {
  maxClaimsPerBatch?: number;
  idleSecs?: number;
  selectClaimChannels?: ClaimChannelSelector;
}

export interface AutoSettlementConfig {
  claimIntervalSecs?: number;
  settleIntervalSecs?: number;
  refundIntervalSecs?: number;
  maxClaimsPerBatch?: number;
  selectClaimChannels?: ClaimChannelSelector;
  shouldSettle?: (context: AutoSettlementContext) => boolean | Promise<boolean>;
  selectRefundChannels?: (
    channels: Channel[],
    context: AutoSettlementContext,
  ) => Channel[] | Promise<Channel[]>;
  onClaim?: (result: ClaimResult) => void;
  onSettle?: (result: SettleResult) => void;
  onRefund?: (result: RefundResult) => void;
  onError?: (error: unknown) => void;
}

export interface AutoSettlementContext {
  now: number;
  lastClaimTime: number;
  lastSettleTime: number;
  /**
   * Whether this manager's network, token, and payTo still need `settle`.
   * Claim, refund, and settle hooks in one pass receive this same meaning.
   * With a reader it is that pass's validated chain observation
   * (`totalClaimed > totalSettled`). An invalid observation throws to the
   * caller or `onError` and the hook is not called. Without a reader it is
   * only the process-local hint. It is not a boolean cached from an earlier pass.
   */
  pendingSettle: boolean;
}

export interface ClaimResult {
  vouchers: number;
  transaction: string;
}

/**
 * Result of one `settle` attempt for this manager's scope.
 * `settled` carries the facilitator transaction string.
 * `already-settled` is a verified noop: this scope was already equal, or a
 * fresh read showed that after nothing-to-settle. A noop has no transaction
 * and no amount.
 */
export type SettleResult =
  | {
      outcome: "settled";
      /**
       * Facilitator-reported transaction string.
       * With a reader, this pair's settled total also moved by at least the
       * reported amount. That movement does not attribute this hash.
       */
      transaction: string;
    }
  | {
      outcome: "already-settled";
      transaction?: never;
    };

export interface RefundResult {
  channel: string;
  transaction: string;
}

type AutoJob = "claim" | "settle" | "refund";

const AUTO_JOB_PRIORITY: AutoJob[] = ["claim", "settle", "refund"];

/**
 * Formats a `Facilitator.settle()` failure into a human-readable error message.
 *
 * @param operation - Operation label (e.g. `"Claim"`, `"Settle"`, `"Refund"`).
 * @param response - The failed settle response.
 * @returns Error message including reason and (when available) facilitator-provided detail.
 */
function formatFacilitatorFailure(operation: string, response: SettleResponse): string {
  return `${operation} failed: ${response.errorReason ?? "unknown"} — ${response.errorMessage ?? ""}`;
}

/**
 * Checks whether a channel has a non-expired payer request reservation.
 *
 * @param channel - Channel state to inspect.
 * @param now - Current wall-clock time in milliseconds.
 * @returns Whether the channel is busy with a live pending request.
 */
function hasLivePendingRequest(channel: Channel, now = Date.now()): boolean {
  return isChannelAdmissionLive(channel.pendingRequest, now);
}

/**
 * Manages the server-side channel lifecycle for the `batch-settlement` scheme:
 * batch claiming of vouchers, settlement of claimed funds, and cooperative refund.
 *
 * Provides one-shot operations (`claim()`, `settle()`, `claimAndSettle()`,
 * `refundIdleChannels()`) and an optional interval runner.
 */
export class BatchSettlementChannelManager {
  private readonly scheme: BatchSettlementEvmScheme;
  private readonly facilitator: FacilitatorClient;
  private readonly receiver: `0x${string}`;
  private readonly token: `0x${string}`;
  private readonly network: Network;

  private timers: Partial<Record<AutoJob, ReturnType<typeof setInterval>>> = {};
  private lastClaimTime = 0;
  private lastSettleTime = 0;
  private pendingSettle = false;
  private readonly admittedOperations = new Set<Promise<unknown>>();
  private activeClaimRefunds = 0;
  private claimFlight: { options: ClaimOptions; flight: Promise<ClaimResult[]> } | null = null;
  private readonly refundFlights = new Map<
    string,
    { binding: string; flight: Promise<RefundResult> }
  >();
  private unresolvedEffect: Error | null = null;
  /** Increments at claim/refund-with-claims admission, before an effect can become unknown. */
  private settleObligation = 0;
  private running = false;
  private stopping = false;
  private stopUsers = 0;
  private pendingJobs = new Set<AutoJob>();
  private autoSettleConfig: AutoSettlementConfig = {};
  private readonly readReceiverSettlement: ReadReceiverSettlement | undefined;
  private settlementFlight: Promise<SettleResult> | null = null;
  private drainFlight: Promise<void> | null = null;
  private stopFlight: Promise<void> | null = null;
  private outsideStopWaiters = 0;
  private callbackDepth = 0;
  private flushRequested = false;
  private reentrantStops: Array<() => void> = [];

  /**
   * Creates a new channel manager.
   *
   * @param config - Manager configuration: scheme, facilitator, receiver, token, network.
   */
  constructor(config: ChannelManagerConfig) {
    this.scheme = config.scheme;
    this.facilitator = config.facilitator;
    this.receiver = config.receiver;
    this.token = config.token;
    this.network = config.network;
    this.readReceiverSettlement = config.readReceiverSettlement;
  }

  /**
   * Collects claimable vouchers and submits them in batches to the facilitator via `claim()`.
   *
   * @param opts - Optional claim execution and target selection options.
   * @param opts.maxClaimsPerBatch - Max vouchers per facilitator `claim` batch.
   * @param opts.idleSecs - When set, only include channels idle for at least this many seconds.
   * @param opts.selectClaimChannels - Optional selector for choosing channels before claimability checks.
   * @returns Array of claim results (one per batch).
   */
  async claim(opts?: ClaimOptions): Promise<ClaimResult[]> {
    return this.admitOperation(() => this.claimNow(opts));
  }

  /**
   * Transfers claimed (but unsettled) funds to the receiver by calling `settle(receiver, token)`.
   *
   * @returns Facilitator-reported transaction string after this manager's settle checks.
   */
  async settle(): Promise<SettleResult> {
    return this.admitOperation(() => this.settleNow());
  }

  /**
   * Convenience: claims all eligible vouchers then settles in one call.
   *
   * @param opts - Optional claim execution and target selection options.
   * @param opts.maxClaimsPerBatch - Max vouchers per claim batch before settling.
   * @param opts.idleSecs - When set, only include channels idle for at least this many seconds.
   * @param opts.selectClaimChannels - Optional selector for choosing channels before claimability checks.
   * @returns Combined claim and settle results.
   */
  async claimAndSettle(
    opts?: ClaimOptions,
  ): Promise<{ claims: ClaimResult[]; settle?: SettleResult }> {
    return this.admitOperation(() => this.claimAndSettleNow(opts));
  }

  /**
   * Initiates cooperative refunds for one or more channels.
   *
   * @param channelIds - Specific channels to refund; defaults to all sessions.
   * @returns One result per successfully refunded channel.
   */
  async refund(channelIds?: string[]): Promise<RefundResult[]> {
    return this.admitOperation(() => this.refundNow(channelIds));
  }

  /**
   * Refunds idle channels with non-zero balances.
   *
   * @param opts - Idle refund options.
   * @param opts.idleSecs - Minimum seconds since the last request.
   * @returns One result per successfully refunded channel.
   */
  async refundIdleChannels(opts: { idleSecs: number }): Promise<RefundResult[]> {
    return this.admitOperation(async () => {
      const channels = await this.getIdleChannelsForRefund(opts.idleSecs);
      return this.refundChannels(channels);
    });
  }

  /**
   * Collects vouchers that are eligible for onchain claiming.
   *
   * A voucher is claimable when its `chargedCumulativeAmount` exceeds what has already
   * been claimed onchain.  An optional idle filter skips sessions that received a
   * request within the last `idleSecs` seconds.
   *
   * @param opts - Optional filtering: `idleSecs` to only return idle channels.
   * @param opts.idleSecs - Minimum seconds since last request for a channel to be included.
   * @returns Array of {@link BatchSettlementVoucherClaim} entries for batch submission.
   */
  async getClaimableVouchers(opts?: { idleSecs?: number }): Promise<BatchSettlementVoucherClaim[]> {
    const channels = await this.scheme.getStorage().list();
    return this.getClaimableVouchersFromChannels(
      channels.filter(channel => this.managesChannel(channel)),
      opts,
    );
  }

  /**
   * Returns channels that have a pending payer-initiated withdrawal.
   *
   * @returns All stored channel records with `withdrawRequestedAt` set.
   */
  async getWithdrawalPendingSessions(): Promise<Channel[]> {
    const channels = await this.scheme.getStorage().list();
    return channels.filter(s => this.managesChannel(s) && s.withdrawRequestedAt > 0);
  }

  /**
   * Starts auto-settlement jobs for configured claim, settle, and refund intervals.
   *
   * @param config - Auto-settlement policy configuration.
   */
  start(config: AutoSettlementConfig = {}): void {
    if (this.running || this.stopping) {
      return;
    }

    const now = Date.now();
    this.lastClaimTime = now;
    this.lastSettleTime = now;
    this.running = true;
    this.autoSettleConfig = config;

    this.startAutoTimer("claim", config.claimIntervalSecs);
    this.startAutoTimer("settle", config.settleIntervalSecs);
    this.startAutoTimer("refund", config.refundIntervalSecs);
  }

  /**
   * Stops the auto-settlement loop.
   *
   * Disables new admission and drops jobs that have not started. An admitted
   * job already in flight is awaited, then `flush` runs one claim-and-settle.
   * Concurrent stops share that shutdown. A stop called from a claim, settle,
   * refund, or error hook does not wait on the job that invoked the hook, so
   * the hook can await `stop` without deadlocking the drain. `start()` works
   * again after this promise resolves.
   *
   * @param opts - Stop options.
   * @param opts.flush - When true, run one `claimAndSettle` after admitted work.
   * @returns Resolves when admitted work and the optional flush have finished.
   */
  async stop(opts?: { flush?: boolean }): Promise<void> {
    if (opts?.flush) {
      this.flushRequested = true;
    }
    this.stopUsers += 1;
    this.stopping = true;
    try {
      if (this.callbackDepth > 0) {
        this.disarmLoop();
        if (this.drainFlight) {
          await new Promise<void>(resolve => {
            this.reentrantStops.push(resolve);
          });
        } else {
          await this.flushIfRequested();
        }
        return;
      }

      if (this.stopFlight) {
        await this.stopFlight;
        return;
      }

      const flight = this.finishStop();
      this.stopFlight = flight;
      try {
        await flight;
      } finally {
        if (this.stopFlight === flight) {
          this.stopFlight = null;
        }
      }
    } finally {
      this.stopUsers -= 1;
      if (this.stopUsers === 0) {
        this.stopping = false;
      }
    }
  }

  /**
   * Runs an already admitted claim, including shutdown's final flush.
   *
   * @param opts - Claim selection and batching policy.
   * @returns Confirmed provider claim results.
   */
  private async claimNow(opts?: ClaimOptions): Promise<ClaimResult[]> {
    this.assertResolvedEffect();
    const options: ClaimOptions = { ...opts, maxClaimsPerBatch: opts?.maxClaimsPerBatch ?? 100 };
    if (this.claimFlight) {
      const previous = this.claimFlight.options;
      if (
        previous.maxClaimsPerBatch !== options.maxClaimsPerBatch ||
        previous.idleSecs !== options.idleSecs ||
        previous.selectClaimChannels !== options.selectClaimChannels
      ) {
        throw new Error("claim already admitted with a different selection or batching policy");
      }
      return this.claimFlight.flight;
    }

    const flight = Promise.resolve().then(async () => {
      const channels = await this.selectClaimTargets(options);
      return this.claimFromChannels(channels, {
        maxClaimsPerBatch: options.maxClaimsPerBatch!,
        ...(options.idleSecs !== undefined ? { idleSecs: options.idleSecs } : {}),
      });
    });
    const admitted = { options, flight };
    this.claimFlight = admitted;
    try {
      return await flight;
    } finally {
      if (this.claimFlight === admitted) this.claimFlight = null;
    }
  }

  /**
   * Shares one settlement among already admitted callers.
   *
   * @returns A transfer assertion or independently observed noop.
   */
  private async settleNow(): Promise<SettleResult> {
    this.assertResolvedEffect();
    if (this.settlementFlight) {
      return this.settlementFlight;
    }

    const flight = this.submitSettle();
    this.settlementFlight = flight;
    try {
      return await flight;
    } finally {
      if (this.settlementFlight === flight) {
        this.settlementFlight = null;
      }
    }
  }

  /**
   * Finishes one admitted claim-and-settle without reopening shutdown admission.
   *
   * @param opts - Claim selection and batching policy.
   * @returns The claim results and optional settlement.
   */
  private async claimAndSettleNow(
    opts?: ClaimOptions,
  ): Promise<{ claims: ClaimResult[]; settle?: SettleResult }> {
    this.assertResolvedEffect();
    const claims = await this.claimNow(opts);
    let settleResult: SettleResult | undefined;
    if (claims.length > 0) {
      settleResult = await this.settleNow();
    } else if (await this.observedPending()) {
      settleResult = await this.settleNow();
    }
    return { claims, settle: settleResult };
  }

  /**
   * Selects scoped refundable rows for an already admitted call.
   *
   * @param channelIds - Optional subset of stored channel ids.
   * @returns Confirmed provider refund results.
   */
  private async refundNow(channelIds?: string[]): Promise<RefundResult[]> {
    const storage = this.scheme.getStorage();
    const channels = (await storage.list()).filter(channel => this.managesChannel(channel));

    const now = Date.now();
    const targets = (
      channelIds
        ? channels.filter(s =>
            channelIds.some(id => id.toLowerCase() === s.channelId.toLowerCase()),
          )
        : channels
    ).filter(channel => this.canRefundChannel(channel, now));

    if (targets.length === 0) {
      return [];
    }

    return this.refundChannels(targets);
  }

  /**
   * Refunds a single channel and removes it from storage after success.
   *
   * @param target - Channel to refund.
   * @returns Successful refund transaction.
   */
  private async refundChannel(target: Channel): Promise<RefundResult> {
    this.assertResolvedEffect();
    unsignedEip155ChainId(this.network);
    target = structuredClone(target);
    const key = target.channelId.toLowerCase();
    const binding = JSON.stringify([
      key,
      target.balance,
      target.totalClaimed,
      target.chargedCumulativeAmount,
      target.signedMaxClaimable,
      target.signature,
      target.refundNonce ?? 0,
    ]);
    const previous = this.refundFlights.get(key);
    if (previous) {
      if (previous.binding !== binding) {
        throw new Error("refund already admitted with different channel amounts or terms");
      }
      return previous.flight;
    }

    const flight = Promise.resolve().then(() => this.submitRefund(target, binding));
    const admitted = { binding, flight };
    this.refundFlights.set(key, admitted);
    this.activeClaimRefunds += 1;
    try {
      return await flight;
    } finally {
      this.activeClaimRefunds -= 1;
      if (this.refundFlights.get(key) === admitted) this.refundFlights.delete(key);
    }
  }

  /**
   * Builds and submits the admitted refund snapshot.
   *
   * @param target - Original channel row and terms.
   * @param binding - Economics frozen before this refund was signed or sent.
   * @returns A confirmed provider refund result.
   */
  private async submitRefund(target: Channel, binding: string): Promise<RefundResult> {
    const admission = await this.scheme.reserveManagerRefund(target, binding);
    const authorizerSigner = this.scheme.getReceiverAuthorizerSigner();
    const claims = this.buildRefundClaims(admission.channel);
    const refundAmount = admission.effectiveAmount;
    const nonce = String(admission.channel.refundNonce ?? 0);

    let paymentPayload: PaymentPayload;
    try {
      const refundAuthorizerSignature = authorizerSigner
        ? await signRefund(
            authorizerSigner,
            admission.channel.channelId as `0x${string}`,
            refundAmount,
            nonce,
            this.network,
          )
        : undefined;
      const claimAuthorizerSignature =
        authorizerSigner && claims.length > 0
          ? await signClaimBatch(authorizerSigner, claims, this.network)
          : undefined;
      paymentPayload = {
        x402Version: 2,
        accepted: this.buildPaymentRequirements(),
        payload: {
          type: "refund",
          channelConfig: admission.channel.channelConfig,
          voucher: {
            channelId: admission.channel.channelId as `0x${string}`,
            maxClaimableAmount: admission.channel.signedMaxClaimable,
            signature: admission.channel.signature as `0x${string}`,
          },
          amount: refundAmount,
          refundNonce: nonce,
          claims,
          ...(refundAuthorizerSignature ? { refundAuthorizerSignature } : {}),
          ...(claimAuthorizerSignature ? { claimAuthorizerSignature } : {}),
        },
      };
    } catch (error) {
      await this.scheme.concludeManagerRefund(admission, "release");
      throw error;
    }

    if (claims.length > 0) this.noteFreshObligation();
    let response: SettleResponse;
    try {
      response = await this.sendOperation("Refund", paymentPayload);
    } catch (error) {
      await this.scheme.concludeManagerRefund(admission, "unknown");
      throw error;
    }
    if (!response.success) {
      if (response.transaction === "" && response.errorReason !== "settlement_pending") {
        await this.scheme.concludeManagerRefund(admission, "release");
        throw new Error(formatFacilitatorFailure("Refund", response));
      }
      await this.scheme.concludeManagerRefund(admission, "unknown", response);
      throw this.rememberUnknown(
        "Refund",
        response.errorMessage || response.errorReason || "facilitator refusal was not final",
      );
    }
    const mismatch = refundEffectMismatch(response, {
      network: this.network,
      effectiveAmount: admission.effectiveAmount,
      payer: admission.channel.channelConfig.payer,
      channelId: admission.channel.channelId,
      originalNonce: String(admission.channel.refundNonce ?? 0),
      previousBalance: admission.channel.balance,
    });
    if (mismatch) {
      await this.scheme.concludeManagerRefund(admission, "unknown", response);
      throw this.rememberUnknown("Refund", mismatch);
    }
    try {
      await this.scheme.concludeManagerRefund(admission, "reconcile", response);
    } catch (error) {
      await this.scheme
        .concludeManagerRefund(admission, "unknown", response)
        .catch(() => undefined);
      throw error;
    }

    return {
      channel: admission.channel.channelId,
      transaction: response.transaction,
    };
  }

  /**
   * Starts a recurring timer for one auto job.
   *
   * @param job - Job to enqueue when the interval fires.
   * @param intervalSecs - Timer interval in seconds.
   */
  private startAutoTimer(job: AutoJob, intervalSecs?: number): void {
    if (intervalSecs === undefined) {
      return;
    }

    this.timers[job] = setInterval(() => {
      this.enqueueJob(job);
    }, intervalSecs * 1000);
  }

  /**
   * Adds an auto job to the coalescing queue.
   *
   * @param job - Job to run.
   */
  private enqueueJob(job: AutoJob): void {
    if (!this.running) {
      return;
    }

    this.pendingJobs.add(job);
    this.ensureDraining();
  }

  /**
   * Starts the single drain flight for already queued jobs.
   */
  private ensureDraining(): void {
    if (this.drainFlight) {
      return;
    }

    const flight = this.runDrain();
    this.drainFlight = flight;
    const clear = () => {
      if (this.drainFlight === flight) this.drainFlight = null;
    };
    void flight.then(clear, clear);
  }

  /**
   * Drains queued auto jobs in priority order.
   * A flush requested from inside a hook runs here, after the hook's job
   * returns, and only when no external `stop` is already waiting to flush.
   *
   * @returns Resolves when the admitted queue and any hook flush have finished.
   */
  private async runDrain(): Promise<void> {
    try {
      while (this.running && this.pendingJobs.size > 0) {
        const job = this.nextPendingJob();
        if (!job) {
          return;
        }
        this.pendingJobs.delete(job);
        await this.runAutoJob(job);
      }
    } finally {
      await this.flushAfterDrain();
    }
  }

  /**
   * Runs a hook-requested flush when no external stop is waiting for this drain.
   * Failures are reported through `onError` so an un-awaited hook stop does not
   * become an unhandled rejection. Reentrant stop promises resolve afterward.
   */
  private async flushAfterDrain(): Promise<void> {
    if (this.outsideStopWaiters > 0) {
      return;
    }

    try {
      if (this.flushRequested) {
        this.flushRequested = false;
        await this.performFlush();
      }
    } catch (error) {
      this.reportError(error);
    } finally {
      this.resolveReentrantStops();
    }
  }

  /**
   * Disables timers and drops jobs that have not started.
   * The job already removed from the queue keeps running.
   */
  private disarmLoop(): void {
    this.running = false;
    for (const timer of Object.values(this.timers)) {
      clearInterval(timer);
    }
    this.timers = {};
    this.pendingJobs.clear();
  }

  /**
   * Awaits the admitted drain, then runs at most the flush requested by this shutdown.
   *
   * @returns Resolves when that shutdown work finishes.
   */
  private async finishStop(): Promise<void> {
    this.disarmLoop();
    this.outsideStopWaiters += 1;
    try {
      const inFlight = this.drainFlight;
      if (inFlight) {
        await inFlight;
      }
      while (this.admittedOperations.size > 0) {
        await Promise.allSettled([...this.admittedOperations]);
      }
      await this.flushIfRequested();
    } finally {
      this.outsideStopWaiters -= 1;
      this.resolveReentrantStops();
    }
  }

  /**
   * Runs one claim-and-settle when a stop asked for a flush.
   *
   * @returns Resolves when that flush finishes.
   */
  private async flushIfRequested(): Promise<void> {
    if (!this.flushRequested) {
      return;
    }
    this.flushRequested = false;
    await this.performFlush();
  }

  /**
   * Claims and settles once with the config captured by the last `start`.
   *
   * @returns The claim and settle results for this flush.
   */
  private performFlush(): Promise<{ claims: ClaimResult[]; settle?: SettleResult }> {
    return this.claimAndSettleNow({
      maxClaimsPerBatch: this.autoSettleConfig.maxClaimsPerBatch,
      selectClaimChannels: this.autoSettleConfig.selectClaimChannels,
    });
  }

  /**
   * Releases hook-initiated `stop` calls that are waiting for the drain to leave their job.
   */
  private resolveReentrantStops(): void {
    const waiters = this.reentrantStops.splice(0);
    for (const resolve of waiters) {
      resolve();
    }
  }

  /**
   * Invokes a hook without awaiting it, and marks the synchronous call as reentrant.
   *
   * @param hook - Optional listener.
   * @param value - Value passed to the listener.
   */
  private emitHook<T>(hook: ((value: T) => void) | undefined, value: T): void {
    if (!hook) {
      return;
    }
    this.callbackDepth += 1;
    try {
      hook(value);
    } finally {
      this.callbackDepth -= 1;
    }
  }

  /**
   * Reports an auto-job or hook-flush failure without presenting it as a boolean.
   *
   * @param error - Failure from a job, a scope read, or a hook flush.
   */
  private reportError(error: unknown): void {
    const hook = this.autoSettleConfig.onError;
    if (!hook) {
      return;
    }
    this.callbackDepth += 1;
    try {
      hook(error);
    } finally {
      this.callbackDepth -= 1;
    }
  }

  /**
   * Returns the highest-priority queued auto job.
   *
   * @returns Next job to run.
   */
  private nextPendingJob(): AutoJob | undefined {
    return AUTO_JOB_PRIORITY.find(job => this.pendingJobs.has(job));
  }

  /**
   * Runs one auto job.
   *
   * @param job - Job to run.
   */
  private async runAutoJob(job: AutoJob): Promise<void> {
    switch (job) {
      case "claim":
        await this.runClaimJob();
        return;
      case "settle":
        await this.runSettleJob();
        return;
      case "refund":
        await this.runRefundJob();
        return;
    }
  }

  /**
   * Runs the claim auto job.
   */
  private async runClaimJob(): Promise<void> {
    const cfg = this.autoSettleConfig;
    try {
      const results = await this.claimNow({
        selectClaimChannels: cfg.selectClaimChannels,
        maxClaimsPerBatch: cfg.maxClaimsPerBatch ?? 100,
      });

      this.lastClaimTime = Date.now();
      for (const result of results) {
        this.emitHook(cfg.onClaim, result);
      }
    } catch (err) {
      this.reportError(err);
    }
  }

  /**
   * Runs the settlement auto job.
   */
  private async runSettleJob(): Promise<void> {
    const cfg = this.autoSettleConfig;
    try {
      const context = await this.autoSettlementContext(Date.now());
      if (cfg.shouldSettle && !(await cfg.shouldSettle(context))) {
        return;
      }
      if (!context.pendingSettle) {
        return;
      }

      const result = await this.settleNow();
      this.lastSettleTime = Date.now();
      this.emitHook(cfg.onSettle, result);
    } catch (err) {
      this.reportError(err);
    }
  }

  /**
   * Runs the refund auto job.
   */
  private async runRefundJob(): Promise<void> {
    const cfg = this.autoSettleConfig;
    if (!cfg.selectRefundChannels) {
      return;
    }

    try {
      const context = await this.autoSettlementContext(Date.now());
      const channels = await this.scheme.getStorage().list();
      const targets = await cfg.selectRefundChannels(channels, context);
      for (const result of await this.refundChannels(targets)) {
        this.emitHook(cfg.onRefund, result);
      }
    } catch (err) {
      this.reportError(err);
    }
  }

  /**
   * Claims vouchers from a provided channel snapshot.
   *
   * @param channels - Channels to inspect for claimable vouchers.
   * @param opts - Claim batching and filtering options.
   * @param opts.maxClaimsPerBatch - Max vouchers per facilitator claim transaction.
   * @param opts.idleSecs - Optional idle filter.
   * @returns Claim results, one per submitted batch.
   */
  private async claimFromChannels(
    channels: Channel[],
    opts: {
      maxClaimsPerBatch: number;
      idleSecs?: number;
    },
  ): Promise<ClaimResult[]> {
    if (!Number.isSafeInteger(opts.maxClaimsPerBatch) || opts.maxClaimsPerBatch <= 0) {
      throw new Error("maxClaimsPerBatch must be a positive safe integer");
    }
    const allClaims = this.getClaimableVouchersFromChannels(
      channels.filter(channel => this.managesChannel(channel)),
      opts.idleSecs !== undefined ? { idleSecs: opts.idleSecs } : undefined,
    );

    if (allClaims.length === 0) {
      return [];
    }

    const results: ClaimResult[] = [];
    for (let i = 0; i < allClaims.length; i += opts.maxClaimsPerBatch) {
      const batch = allClaims.slice(i, i + opts.maxClaimsPerBatch);
      this.assertResolvedEffect();
      this.noteFreshObligation();
      this.activeClaimRefunds += 1;
      try {
        const result = await this.submitClaim(structuredClone(batch));
        results.push(result);
        await this.updateClaimedSessions(batch);
      } finally {
        this.activeClaimRefunds -= 1;
      }
    }

    return results;
  }

  /**
   * Loads stored channels and applies the configured claim selector, if any.
   *
   * @param opts - Claim options containing an optional target selector.
   * @returns The channel snapshot that should be inspected for claimable vouchers.
   */
  private async selectClaimTargets(
    opts?: Pick<ClaimOptions, "selectClaimChannels">,
  ): Promise<Channel[]> {
    const channels = (await this.scheme.getStorage().list()).filter(channel =>
      this.managesChannel(channel),
    );
    if (!opts?.selectClaimChannels) {
      return channels;
    }

    const context = await this.autoSettlementContext(Date.now());
    return opts.selectClaimChannels(channels, context);
  }

  /**
   * Joins an in-process refund. Its pending row is the shared admission, not a second lock.
   * A pending row with no local flight belongs to another request and is left alone.
   *
   * @param channel - Stored channel row
   * @param now - Current time in milliseconds
   * @returns Whether this manager may enter or join the refund
   */
  private canRefundChannel(channel: Channel, now = Date.now()): boolean {
    if (!this.managesChannel(channel)) {
      return false;
    }
    if (this.refundFlights.has(channel.channelId.toLowerCase())) {
      return true;
    }
    return !hasLivePendingRequest(channel, now);
  }

  /**
   * Refunds each eligible channel independently.
   *
   * @param channels - Channels to refund.
   * @returns Successful refund results.
   */
  private async refundChannels(channels: Channel[]): Promise<RefundResult[]> {
    const results: RefundResult[] = [];
    for (const channel of channels) {
      if (!this.canRefundChannel(channel)) {
        continue;
      }
      results.push(await this.refundChannel(channel));
    }
    return results;
  }

  /**
   * Builds an outstanding voucher claim for a refund payload.
   *
   * @param channel - Channel being refunded.
   * @returns Claim payloads needed before refunding unclaimed balance.
   */
  private buildRefundClaims(channel: Channel): BatchSettlementVoucherClaim[] {
    if (BigInt(channel.chargedCumulativeAmount) <= BigInt(channel.totalClaimed)) {
      return [];
    }

    return [
      {
        voucher: {
          channel: channel.channelConfig,
          maxClaimableAmount: channel.signedMaxClaimable,
        },
        signature: channel.signature as `0x${string}`,
        totalClaimed: channel.chargedCumulativeAmount,
      },
    ];
  }

  /**
   * Builds the policy context passed to interval hooks.
   *
   * @param now - Current wall-clock time in milliseconds.
   * @returns Auto-settlement policy context.
   */
  private buildAutoSettlementContext(now: number): AutoSettlementContext {
    return {
      now,
      lastClaimTime: this.lastClaimTime,
      lastSettleTime: this.lastSettleTime,
      pendingSettle: this.pendingSettle,
    };
  }

  /**
   * Builds the hook context for this pass.
   * A configured reader replaces the copied hint with the validated chain
   * observation. The chain boolean is not written back onto the local hint.
   *
   * @param now - Current wall-clock time in milliseconds.
   * @returns Context whose `pendingSettle` has one meaning for every hook.
   */
  private async autoSettlementContext(now: number): Promise<AutoSettlementContext> {
    const context = this.buildAutoSettlementContext(now);
    if (!this.readReceiverSettlement) {
      return context;
    }

    const snapshot = await this.readScopedSnapshot();
    return {
      ...context,
      pendingSettle: snapshot.totalClaimed > snapshot.totalSettled,
    };
  }

  /**
   * Records a newly claimed obligation that a settle already in flight must not clear.
   */
  private noteFreshObligation(): void {
    this.settleObligation += 1;
    this.pendingSettle = true;
  }

  /**
   * Clears the local hint only when no claim or refund-with-claims committed
   * after this settle attempt began.
   *
   * @param seen - Obligation generation captured at the start of the attempt.
   */
  private clearSettledObligation(seen: number): void {
    if (seen === this.settleObligation && this.activeClaimRefunds === 0 && !this.unresolvedEffect) {
      this.pendingSettle = false;
    }
  }

  /**
   * Collects claimable vouchers from a provided channel snapshot.
   *
   * @param channels - Channels to inspect.
   * @param opts - Optional idle filter.
   * @param opts.idleSecs - Minimum seconds since last request.
   * @returns Claimable voucher payloads.
   */
  private getClaimableVouchersFromChannels(
    channels: Channel[],
    opts?: { idleSecs?: number },
  ): BatchSettlementVoucherClaim[] {
    const now = Date.now();
    const claims: BatchSettlementVoucherClaim[] = [];

    for (const c of channels) {
      if (BigInt(c.chargedCumulativeAmount) <= BigInt(c.totalClaimed)) {
        continue;
      }
      if (opts?.idleSecs !== undefined) {
        const idleMs = now - c.lastRequestTimestamp;
        if (idleMs < opts.idleSecs * 1000) {
          continue;
        }
      }
      claims.push({
        voucher: {
          channel: c.channelConfig,
          maxClaimableAmount: c.signedMaxClaimable,
        },
        signature: c.signature as `0x${string}`,
        totalClaimed: c.chargedCumulativeAmount,
      });
    }

    return claims;
  }

  /**
   * Filters idle channels that can be cooperatively refunded.
   *
   * @param channels - Channels to inspect.
   * @param idleSecs - Minimum seconds since the last request.
   * @returns Idle refundable channels.
   */
  private getIdleChannelsForRefundFromChannels(channels: Channel[], idleSecs: number): Channel[] {
    const now = Date.now();
    const idleMs = idleSecs * 1000;
    return channels.filter(c => {
      if (BigInt(c.balance) === 0n) return false;
      if (hasLivePendingRequest(c, now)) return false;
      return now - c.lastRequestTimestamp >= idleMs;
    });
  }

  /**
   * Returns channels that have been idle longer than `idleSecs` and still have
   * a non-zero balance (candidates for cooperative refund).
   *
   * @param idleSecs - Minimum seconds since last request for a session to count as idle.
   * @returns Channels meeting the idle and balance criteria.
   */
  private async getIdleChannelsForRefund(idleSecs: number): Promise<Channel[]> {
    const channels = await this.scheme.getStorage().list();
    return this.getIdleChannelsForRefundFromChannels(
      channels.filter(channel => this.managesChannel(channel)),
      idleSecs,
    );
  }

  /**
   * Submits a batch of voucher claims to the facilitator.
   *
   * @param claims - Voucher claims to send in one `type: "claim"` payload.
   * @returns Per-batch claim summary (count and transaction hash).
   */
  private async submitClaim(claims: BatchSettlementVoucherClaim[]): Promise<ClaimResult> {
    unsignedEip155ChainId(this.network);
    const authorizerSigner = this.scheme.getReceiverAuthorizerSigner();

    const claimAuthorizerSignature = authorizerSigner
      ? await signClaimBatch(authorizerSigner, claims, this.network)
      : undefined;

    const paymentPayload: PaymentPayload = {
      x402Version: 2,
      accepted: this.buildPaymentRequirements(),
      payload: {
        type: "claim",
        claims,
        ...(claimAuthorizerSignature ? { claimAuthorizerSignature } : {}),
      },
    };

    const response = await this.sendOperation("Claim", paymentPayload);

    if (!response.success) {
      throw new Error(formatFacilitatorFailure("Claim", response));
    }

    return { vouchers: claims.length, transaction: response.transaction };
  }

  /**
   * Submits one settle for this manager's payTo and token.
   *
   * With a reader, an already-equal scope returns `already-settled` and does not
   * call the facilitator. A success counts only when it names this manager's
   * network, carries a 32-byte hash and a positive decimal amount, and a fresh
   * read shows this pair's settled total increased by at least that amount. The
   * increase does not prove the returned hash caused it. Nothing-to-settle returns
   * the same noop only when a fresh read shows this scope equal and no newer
   * claim or refund-with-claims committed during the attempt. A still-pending,
   * foreign, or malformed observation throws and leaves the obligation in place.
   * A different or absent response network stays outcome unknown and is not this
   * manager's completion, even if the pair total later moves.
   *
   * Without a reader, facilitator success remains the completion signal. That
   * legacy path is explicit and is not chain proof. Success clears the local
   * hint only when the obligation generation is unchanged, so a claim or refund
   * that commits while the request is in flight is not erased. Nothing-to-settle
   * without a reader throws and does not clear the hint.
   *
   * @returns A settled transaction, or a verified already-settled noop with no transaction.
   */
  private async submitSettle(): Promise<SettleResult> {
    this.assertResolvedEffect();
    unsignedEip155ChainId(this.network);
    if (this.activeClaimRefunds > 0) {
      throw new Error("Settle outcome unknown: a claim or refund is still in flight");
    }
    const seenObligation = this.settleObligation;
    const before = this.readReceiverSettlement ? await this.readScopedSnapshot() : undefined;
    this.assertResolvedEffect();
    if (this.activeClaimRefunds > 0) {
      throw new Error("Settle outcome unknown: a claim or refund is still in flight");
    }
    if (
      before &&
      before.totalClaimed === before.totalSettled &&
      seenObligation === this.settleObligation
    ) {
      this.clearSettledObligation(seenObligation);
      return { outcome: "already-settled" };
    }

    const response = await this.sendOperation("Settle", this.buildSettlePaymentPayload());
    if (!response.success) {
      if (response.errorReason === ErrNothingToSettle && before) {
        const fresh = await this.readScopedSnapshot();
        if (fresh.totalClaimed === fresh.totalSettled && seenObligation === this.settleObligation) {
          this.clearSettledObligation(seenObligation);
          return { outcome: "already-settled" };
        }
      }
      throw new Error(formatFacilitatorFailure("Settle", response));
    }

    if (response.network !== this.network) {
      throw new Error(
        "Settle outcome unknown: facilitator response did not name this manager's network",
      );
    }

    if (!/^0x[0-9a-fA-F]{64}$/.test(response.transaction)) {
      throw new Error(
        "Settle outcome unknown: facilitator reported success without a transaction hash",
      );
    }
    if (!/^\d+$/.test(response.amount ?? "") || BigInt(response.amount ?? "0") === 0n) {
      throw this.rememberUnknown(
        "Settle",
        "no Settled transfer was observed for this receiver and token",
      );
    }

    if (!before) {
      // A scoped, well-formed facilitator response remains a provider assertion,
      // not an independently observed transfer.
      this.clearSettledObligation(seenObligation);
      return { outcome: "settled", transaction: response.transaction };
    }

    const amount = BigInt(response.amount ?? "0");
    let after: ReceiverSettlementSnapshot;
    try {
      after = await this.readScopedSnapshot();
    } catch (error) {
      throw this.rememberUnknown("Settle", error instanceof Error ? error.message : String(error));
    }
    if (after.totalSettled < before.totalSettled + amount) {
      throw this.rememberUnknown("Settle", "settled total did not increase by the reported amount");
    }
    if (after.totalClaimed === after.totalSettled) {
      this.clearSettledObligation(seenObligation);
    }
    return { outcome: "settled", transaction: response.transaction };
  }

  /**
   * Reports whether this manager's own network, token, and payTo still have
   * claimed funds that have not been settled.
   *
   * @returns True when a settle should be attempted.
   */
  private async observedPending(): Promise<boolean> {
    if (!this.readReceiverSettlement) {
      return this.pendingSettle;
    }
    const snapshot = await this.readScopedSnapshot();
    return snapshot.totalClaimed > snapshot.totalSettled;
  }

  /**
   * Reads and checks the receiver state for this manager's scope.
   *
   * @returns Snapshot of claimed and settled totals for this payTo and token.
   */
  private async readScopedSnapshot(): Promise<ReceiverSettlementSnapshot> {
    if (!this.readReceiverSettlement) {
      throw new Error("receiver settlement reader is not configured");
    }
    unsignedEip155ChainId(this.network);
    const receiver = getAddress(this.receiver);
    const token = getAddress(this.token);
    const snapshot = await this.readReceiverSettlement({
      network: this.network,
      receiver: this.receiver,
      token: this.token,
    });
    if (
      !snapshot ||
      snapshot.network !== this.network ||
      getAddress(snapshot.receiver) !== receiver ||
      getAddress(snapshot.token) !== token
    ) {
      throw new Error(
        "pending settlement observation left this manager's network, token, or payTo",
      );
    }
    const totals = assertReceiverSettlementTotals(snapshot.totalClaimed, snapshot.totalSettled);
    return {
      network: snapshot.network,
      receiver: snapshot.receiver,
      token: snapshot.token,
      totalClaimed: totals.totalClaimed,
      totalSettled: totals.totalSettled,
    };
  }

  /**
   * Storage may be shared across managers; a selector cannot widen this scope.
   *
   * @param channel - Stored or selected channel.
   * @returns Whether its receiver, token, and chain-bound id belong to this manager.
   */
  private managesChannel(channel: Channel): boolean {
    unsignedEip155ChainId(this.network);
    return (
      getAddress(channel.channelConfig.receiver) === getAddress(this.receiver) &&
      getAddress(channel.channelConfig.token) === getAddress(this.token) &&
      computeChannelId(channel.channelConfig, this.network).toLowerCase() ===
        channel.channelId.toLowerCase()
    );
  }

  /**
   * Tracks direct work as well as the auto drain; rejection still releases admission.
   *
   * @param run - Operation admitted before shutdown.
   * @returns Its result after all associated work ends.
   */
  private async admitOperation<T>(run: () => Promise<T>): Promise<T> {
    if (this.stopping) throw new Error("channel manager is stopping");
    this.assertResolvedEffect();
    const flight = run();
    this.admittedOperations.add(flight);
    try {
      return await flight;
    } finally {
      this.admittedOperations.delete(flight);
    }
  }

  /** An unknown financial effect is never spending capacity or permission to resend. */
  private assertResolvedEffect(): void {
    if (this.unresolvedEffect) throw this.unresolvedEffect;
  }

  /**
   * Keeps one unresolved effect on this existing receiver/token manager.
   *
   * @param operation - Claim, refund, or settlement label.
   * @param detail - Observed reason the effect cannot be established.
   * @returns The retained error for this and subsequent calls.
   */
  private rememberUnknown(operation: string, detail: string): Error {
    const error = new Error(
      `${operation} outcome unknown: ${detail}; prior effect remains unresolved`,
    );
    this.unresolvedEffect = error;
    this.pendingSettle = true;
    return error;
  }

  /**
   * Checks the provider response before local claim/refund/settle state changes.
   *
   * @param operation - Operation label for error reporting.
   * @param payload - Frozen request and accepted terms.
   * @returns A scoped, well-formed provider response.
   */
  private async sendOperation(operation: string, payload: PaymentPayload): Promise<SettleResponse> {
    this.assertResolvedEffect();
    let response: SettleResponse;
    try {
      response = await this.facilitator.settle(payload, this.buildPaymentRequirements());
    } catch (error) {
      throw this.rememberUnknown(operation, error instanceof Error ? error.message : String(error));
    }
    if (!response || typeof response.success !== "boolean") {
      throw this.rememberUnknown(operation, "facilitator response is malformed");
    }
    if (response.network !== this.network) {
      throw this.rememberUnknown(
        operation,
        "facilitator response did not name this manager's network",
      );
    }
    if (response.errorReason === "settlement_pending") {
      throw this.rememberUnknown(
        operation,
        `pending transaction ${response.transaction || "unknown"}`,
      );
    }
    if (response.success && !/^0x[0-9a-fA-F]{64}$/.test(response.transaction)) {
      throw this.rememberUnknown(
        operation,
        "facilitator reported success without a transaction hash",
      );
    }
    if (response.errorReason === ErrNothingToSettle && response.transaction !== "") {
      throw this.rememberUnknown(operation, "nothing-to-settle response carried a transaction");
    }
    return response;
  }

  /**
   * Builds a settlement payment payload for `settle(receiver, token)`.
   *
   * @returns Payload with `type: "settle"` and receiver/token fields.
   */
  private buildSettlePaymentPayload(): PaymentPayload {
    return {
      x402Version: 2,
      accepted: this.buildPaymentRequirements(),
      payload: {
        type: "settle",
        receiver: this.receiver,
        token: this.token,
      },
    };
  }

  /**
   * Builds a minimal {@link PaymentRequirements} for channel manager operations.
   *
   * @returns Requirements describing batched operations for this manager.
   */
  private buildPaymentRequirements(): PaymentRequirements {
    return {
      scheme: BATCH_SETTLEMENT_SCHEME,
      network: this.network,
      asset: this.token,
      amount: "0",
      payTo: this.receiver,
      maxTimeoutSeconds: 0,
      extra: {},
    };
  }

  /**
   * Updates session records after a successful claim submission so that
   * `getClaimableVouchers` no longer returns already-claimed vouchers.
   *
   * @param claims - Voucher claims that were included in the submitted settlement transaction.
   */
  private async updateClaimedSessions(claims: BatchSettlementVoucherClaim[]): Promise<void> {
    const storage = this.scheme.getStorage();
    for (const claim of claims) {
      const channelId = computeChannelId(claim.voucher.channel, this.network);
      const channel = await storage.get(channelId);
      if (!channel) {
        continue;
      }
      const claimedAmount = BigInt(claim.totalClaimed);
      if (claimedAmount <= BigInt(channel.totalClaimed)) {
        continue;
      }
      await storage.updateChannel(channelId, current => {
        if (!current || claimedAmount <= BigInt(current.totalClaimed)) {
          return current;
        }
        return {
          ...current,
          totalClaimed: claimedAmount.toString(),
        };
      });
    }
  }
}
