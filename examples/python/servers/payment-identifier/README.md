# Payment-Identifier Extension Server Example

Example server demonstrating how to implement the `payment-identifier` extension for **idempotent** payment processing.

## How It Works

1. Server advertises `payment-identifier` extension support in PaymentRequired responses
2. Server extracts payment ID from incoming PaymentPayload using `extract_payment_identifier()`
3. After settlement, server caches the response keyed by payment ID plus an HTTP request fingerprint (method, canonical path+query, raw body SHA-256, accepted terms)
4. Same payment ID and same fingerprint return the cached response without payment processing
5. Same payment ID with a different method, path, query, or body returns HTTP 409 and does not grant access

```python
from x402.extensions.payment_identifier import (
    PAYMENT_IDENTIFIER,
    declare_payment_identifier_extension,
    extract_payment_identifier,
)
from x402.server import x402ResourceServer

server = x402ResourceServer(facilitator)

# Advertise extension support in route config
routes = {
    "GET /weather": RouteConfig(
        accepts=[...],
        extensions={
            PAYMENT_IDENTIFIER: declare_payment_identifier_extension(required=False),
        },
    ),
}

# Cache response after settlement, including the request fingerprint
async def after_settle(ctx):
    payment_id = extract_payment_identifier(ctx.payment_payload)
    fingerprint = pending_fingerprints.pop(payment_id, None) if payment_id else None
    if payment_id and fingerprint:
        idempotency_cache[payment_id] = cached_response

server.on_after_settle(after_settle)
```

## Prerequisites

- Python 3.10+
- uv (install via [docs.astral.sh/uv](https://docs.astral.sh/uv/getting-started/installation/))
- Valid EVM address for receiving payments (Base Sepolia)

## Setup

1. Install dependencies:

```bash
uv sync
```

2. Copy `.env-local` to `.env` and add your EVM address:

```bash
cp .env-local .env
```

Required environment variable:

- `EVM_ADDRESS` - Ethereum address to receive payments

3. Run the server:

```bash
uv run python main.py
```

## Expected Output

```
Payment-Identifier Example Server
   Listening at http://localhost:4022

Idempotency Configuration:
   - Cache TTL: 1 hour
   - Payment ID: optional (required: false)

How it works:
   1. Client sends payment with a unique payment ID
   2. Server caches the response bound to that ID and the HTTP request
   3. Same ID and same request fingerprint returns the cached response
   4. Same ID with a different method, path, query, or body returns 409
   5. No duplicate payment processing occurs on a cache hit
```

Request-binding unit tests (no wallet, chain, facilitator, or payment):

```bash
python3 -m unittest test_request_binding.py
```

When requests come in:

```
[Idempotency] Checking payment ID: pay_7d5d747be160e280504c099d984bcfe0
[Idempotency] Cache MISS - proceeding with payment
[Idempotency] Caching response for payment ID: pay_7d5d747be160e280504c099d984bcfe0

[Idempotency] Checking payment ID: pay_7d5d747be160e280504c099d984bcfe0
[Idempotency] Cache HIT - returning cached response (age: 2s)
```

## Testing with the Client

Run the [payment-identifier client example](../../clients/payment-identifier) in another terminal:

```bash
cd ../../clients/payment-identifier
uv run python main.py
```

## Extension Configuration

### Optional Payment ID (Default)

```python
extensions={
    PAYMENT_IDENTIFIER: declare_payment_identifier_extension(required=False),
}
```

Clients may optionally provide a payment ID. If provided, it enables idempotency.

### Required Payment ID

```python
extensions={
    PAYMENT_IDENTIFIER: declare_payment_identifier_extension(required=True),
}
```

Clients must provide a payment ID. Requests without one will be rejected.

## Production Considerations

1. **Use a distributed cache** (Redis, Memcached) instead of in-memory dict
2. **Configure appropriate TTL** based on your use case
3. **Bind payment IDs to the HTTP request** (method, canonical path+query, raw body, accepted terms) and return 409 on drift
4. **Monitor cache hit rates** to optimize performance
