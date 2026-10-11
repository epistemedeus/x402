# x402 #3750 regression references

Synthetic regression source for [x402 #3750](https://github.com/x402-foundation/x402/issues/3750), prepared against SDK base `f8f83309706b14cc696962f0a002eeeb66c3dc26`.

- [Core context cases](typescript/packages/core/test/unit/client/requestContext.test.ts.txt)
- [Fetch body and recovery cases](typescript/packages/http/fetch/src/requestContext.test.ts.txt)
- [MCP invocation cases](typescript/packages/mcp/test/unit/requestContext.test.ts.txt)

These are reference-only `.txt` copies of existing prototype tests. This branch adds no runtime implementation and does not execute these files. They require adaptation before inclusion in an SDK test suite; the Fetch source also imports the prototype-only `requestCall` helper.

The prototype uses `call.transport`, with nested `request` or `toolCall`. The current proposal instead uses `call.kind`, direct HTTP fields, `toolName`, and an optional `getBody(signal)` parameter. These references do not decide that API.

Covered behavior includes concurrent per-call context, stable MCP invocation values across unpaid/paid/recovery RPCs despite caller or hook mutation, lazy body access, mid-read abort, memoized failures, and avoiding an unused reader clone. All inputs are synthetic; no credentials, real payment traffic or private receipts are included.

Recorded executions reproduced missing context on the unmodified base and transmission/body-reader failures in the earlier prototype. The corrected prototype passed its normal package suites. Those results are not a claim that these reference files run unchanged on the base or this branch.

Maintainer decisions remain open: `call` versus `request`, final shape, and whether HTTP and MCP wiring land together or separately.
