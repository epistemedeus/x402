# EVM receiving 211204

Ready for Root to receive as a private financial candidate. The complete tested
consumer runs from the built SDK through HTTP verification, claim/refund,
original-transaction reconciliation, scoped receiver settlement, and shutdown.
No upstream merge, SDK publication, production deployment, or funded chain call
was performed. This is owner QA, not adoption, customers, savings, or revenue.

## Exact source and provenance

- Upstream: `f8f83309706b14cc696962f0a002eeeb66c3dc26`, Apache-2.0.
- Original private Pilot carrier: `23d511338d662380a7cecd5ac6e46e4defd1f00f`.
- Preserved original SDK attribution: `9d00f142c5ab8c7e15db4168609d25de57487828`, a locally reported, unpushed commit. It was not fetched or recreated as that SHA.
- The preserved full patch was a raw nine-file diff, not an mbox. `git apply --index --check` then `git apply --index` produced exactly `2ec747c7e66f63a0f8c2c25272aca63a57cd8826` before reproduction.
- Reconstructed materialization commit: `953b5a2bd5e38979a25700ed800f0e910a1f0460`, with that exact original tree.
- Tested implementation: `bf4075674d1bd71a62d5279f3a41df28e4d7b964`; tree `f1c3a364764727a0e4cef61d1e412a7c0bf769f1`.
- Feature: `codex/evm-receiving-211204`, retained locally and exported privately with a full patch and Git bundle. The outer receiving receipt pins the later documentation-inclusive head/tree.

Native `gpt-6.1-sol`, actual effort `max`, OpenAI session
`01a128e2-7803-7301-9ed7-170e9f468542`, CLI `0.162.1`, on the assigned Cursor VM.
No child model, Cursor inference, paid API inference, Bot dispatch, reset of a
provider allowance, or overage was used.

## Received defects and correction

Manager admission now covers direct and auto claim/refund work, rejection,
repeated stops, and reentrant hooks. Matching in-flight calls share signatures
and submission. Claim obligations are recorded before effects or storage writes;
a same-generation completion cannot clear a newly admitted obligation. Shared
storage and selectors remain constrained to the exact chain-bound channel,
receiver, and token. Invalid batch sizes fail before signing.

The reader independently queries RPC chain identity in addition to configured
chain metadata. An Anvil RPC serving chain 31337 while configured as chain 1
previously labeled its real receiver funds `eip155:1`; that exact failure is now
refused. Canonical reference parsing was already correct for the tested trailing
terminators, so no global parser replacement was introduced.

The existing facilitator retains the exact batch request and original receipt
continuation. Pending, unknown-status, foreign-hash, invalid-hash, and lost-write
outcomes do not authorize a new signature or broadcast. Changed requests receive
a known busy refusal, separate from the unresolved original effect. No expiry
turns the effect into a new attempt.

Two lost receipt replies exhaust core's existing automatic retry. The next HTTP
refund previously failed fresh verification with no balance after its original
transaction mined. The server now resumes the original verified refund and signed
enrichment; the live client retains its exact request and payer signature.
Changed terms, transport, or channel ceilings are refused before signing, and
new channel payments remain blocked while the refund is unresolved. Admission
generations protect newer refunds from late cleanup. Foreign/malformed refund
success assertions preserve server and client financial state. Core logs
post-settle hook errors; the SDK client's explicit boundary is load-bearing.

The actual manager API returns `{outcome:"already-settled"}` without transaction
or amount. Its union's `transaction?: never` supports existing property inspection
as `string | undefined`. `ReceiverSettlementAPI` in the standalone consumer is
an alias of the actual factory return type, not a new exported service.

## Verification on the VM

| Command / route | Result |
| --- | --- |
| Original candidate `pnpm exec vitest run` | 1,644 passed |
| Original candidate local Anvil target | 11 passed |
| Final `pnpm test` | 55 files, 1,708 tests passed; statements 95.31%, branches 91.09% |
| Final `pnpm build` | ESM, CJS, and declaration build passed |
| Final `pnpm lint:check` | Passed; existing module-type warning retained |
| `pnpm exec tsc --noEmit -p tsconfig.json` | Exit 2, exactly the same two upstream `Crypto` diagnostics at `src/utils.ts:38,39`; no suppression or configuration change |
| Strict standalone public declaration consumer | Passed with ES2022/DOM, NodeNext and `--skipLibCheck`; owning source check above remains unsuppressed |
| Built ESM and CJS noop consumers | Passed, no facilitator call, no transaction/amount |
| Loopback-only Anvil integration target | 26 passed; zero extra payer signatures, authorizer signatures, or broadcasts on exact HTTP pending retries |
| Existing `forge build` | Passed; contracts unchanged |

The Anvil target is
`pnpm exec vitest run --config vitest.integration.config.ts test/integrations/batch-settlement-refund-settlement.test.ts`
with Foundry on PATH. It imports actual public package builds, sends only local
RPC calls, observes real receipts and `Settled` events, checks exact receiver/token
totals and balances, and awaits its owned child exit. Full/partial concurrent
HTTP refunds, claim/refund/settle continuation, direct shutdown, rejected work,
hooks, stop/start, generation interleavings, wrong RPC identity, and useful
negative outputs are included. All failed reproductions and setup attempts are
retained in the outer private log collection.

## Reuse, receiving, and limits

Reusable asset: the existing EVM batch-settlement lifecycle and regression
consumers, using maintained viem/core receipt machinery under existing licenses.
Strongest direct route: existing SDK HTTP refund plus original receipt
continuation, and `readBatchSettlementReceiverState` for independently scoped
receiver totals. It requires no new global transaction service.

Receiving owner: Root. Next consumer: Root's existing x402 financial receiving
lane and upstream issue-3730 integration review, at the exact private source pin.
The reader remains opt-in; default activation/adoption is not established. Pair
movement alone never attributes a transaction hash. A manager that received an
unknown effect remains quarantined even after a separate provider continuation
confirms it. Live client/server/facilitator records are not durable across process
replacement or independent replicas; those require independent recovery. A raw
HTTP adapter that ignores SDK client validation can still expose an untrusted
provider success assertion because core logs hook errors. This export does not
change core or claim that boundary is solved for arbitrary consumers. Original
unknown attribution and lack of independent adoption remain unchanged.
