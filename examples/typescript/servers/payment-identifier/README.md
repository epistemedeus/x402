# Payment-Identifier Extension Server Example

Express.js server demonstrating how to use the `payment-identifier` extension for **idempotency** - avoiding duplicate payment processing when clients retry requests with the same payment ID.

## How It Works

1. Server advertises `payment-identifier` extension support in the `PaymentRequired` response
2. Client includes a unique payment ID in their `PaymentPayload`
3. Server caches responses keyed by payment ID plus an HTTP request fingerprint (1-hour TTL)
4. Same payment ID and same fingerprint return the cached response without re-processing payment
5. Same payment ID with a different method, path, query, or body returns HTTP 409 and does not grant access

```typescript
import { paymentMiddlewareFromHTTPServer } from "@x402/express";

// Bind each payment ID to an HTTP request fingerprint (see request-binding.ts).
// Check the cache in Express middleware before payment middleware.
// Same fingerprint: return the cached body. Different fingerprint: HTTP 409.
// Do not return { grantAccess: true } on fingerprint mismatch.

app.use(idempotencyMiddleware); // 200 cache hit or 409 conflict, no grantAccess
app.use(paymentMiddlewareFromHTTPServer(httpServer));
```

## Prerequisites

- Node.js v20+ (install via [nvm](https://github.com/nvm-sh/nvm))
- pnpm v10 (install via [pnpm.io/installation](https://pnpm.io/installation))
- Valid EVM address for receiving payments (Base Sepolia)

## Setup

1. Copy `.env-local` to `.env`:

```bash
cp .env-local .env
```

and fill required environment variable:

- `ADDRESS` - Ethereum address to receive payments

2. Install and build all packages from the typescript examples root:

```bash
cd ../../
pnpm install && pnpm build
cd servers/payment-identifier
```

3. Run the server:

```bash
pnpm dev
```

## Testing with the Client

Run the payment-identifier client example to test idempotency:

```bash
cd ../../clients/payment-identifier
# Ensure .env is setup
pnpm dev
```

The client will:
1. Make a request with a unique payment ID
2. Make a second request with the **same** payment ID
3. The second request returns instantly from cache without payment processing

## Idempotency Behavior

| Scenario | Server Response |
|----------|-----------------|
| New payment ID | Process payment normally, cache response |
| Same payment ID, same request fingerprint (within TTL) | Return cached response, skip payment |
| Same payment ID, different request fingerprint | Return 409 Conflict, do not grant access |
| Same payment ID (after TTL) | Process payment normally, update cache |
| No payment ID | Process payment normally (no caching) |

## Configuration Options

### Required vs Optional

```typescript
// Payment ID is optional (clients can omit it)
declarePaymentIdentifierExtension(false)

// Payment ID is required (clients must provide it)
declarePaymentIdentifierExtension(true)
```

### Cache TTL

Adjust `CACHE_TTL_MS` based on your use case:
- Short TTL (5-15 min): For time-sensitive resources
- Long TTL (1-24 hours): For static or infrequently changing resources

Request-binding unit tests (no wallet, chain, facilitator, or payment):

```bash
pnpm test
```

## Production Considerations

1. **Use Redis or similar** instead of in-memory cache for distributed systems
2. **Handle cache failures gracefully** - if cache is unavailable, process payment normally
3. **Bind payment IDs to the HTTP request** - fingerprint method, canonical path+query, raw body, and accepted terms. Do not hash only the payment payload. Return 409 on drift without grantAccess.
4. **Monitor cache hit rates** to tune TTL and detect abuse
