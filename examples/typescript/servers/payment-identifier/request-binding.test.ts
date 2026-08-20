import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lookup, requestFingerprint } from "./request-binding.ts";

const PAYMENT_ID = "pay_aaaaaaaaaaaaaaaa";
const TTL_MS = 3600_000;
const NOW = 1_000_000;
const WEATHER = "http://localhost:4022/weather";
const FORECAST = "http://localhost:4022/forecast";

const PAYLOAD = {
  x402Version: 2,
  accepted: {
    scheme: "exact",
    network: "eip155:84532",
    asset: "0x0000000000000000000000000000000000000001",
    amount: "1000",
    payTo: "0x0000000000000000000000000000000000000002",
  },
  payload: { signature: "0xsig" },
  extensions: {
    "payment-identifier": { info: { id: PAYMENT_ID, required: false } },
  },
};

const fp = (
  input: { method?: string; url?: string; body?: Buffer | string; payload?: typeof PAYLOAD } = {},
) =>
  requestFingerprint({
    method: input.method ?? "GET",
    url: input.url ?? WEATHER,
    body: input.body ?? Buffer.alloc(0),
    payload: input.payload ?? PAYLOAD,
  });

const cached = (fingerprint: string) => ({
  timestamp: NOW,
  fingerprint,
  response: { report: { weather: "sunny" } },
});

describe("request-bound payment identifier", () => {
  it("hits on an identical retry", () => {
    const decision = lookup(cached(fp()), fp(), NOW + 1, TTL_MS);
    assert.equal(decision.kind, "hit");
    assert.equal(decision.statusCode, 200);
    assert.equal(decision.grantAccess, true);
  });

  it("returns 409 and does not grant access on method drift", () => {
    const decision = lookup(cached(fp({ method: "GET" })), fp({ method: "POST" }), NOW + 1, TTL_MS);
    assert.equal(decision.statusCode, 409);
    assert.equal(decision.grantAccess, false);
  });

  it("returns 409 and does not grant access on path drift", () => {
    const decision = lookup(cached(fp({ url: WEATHER })), fp({ url: FORECAST }), NOW + 1, TTL_MS);
    assert.equal(decision.statusCode, 409);
    assert.equal(decision.grantAccess, false);
  });

  it("returns 409 and does not grant access on body drift", () => {
    const decision = lookup(
      cached(fp({ body: Buffer.alloc(0) })),
      fp({ body: '{"city":"nyc"}' }),
      NOW + 1,
      TTL_MS,
    );
    assert.equal(decision.statusCode, 409);
    assert.equal(decision.grantAccess, false);
  });

  it("returns 409 and does not grant access on query drift", () => {
    const decision = lookup(
      cached(fp({ url: WEATHER })),
      fp({ url: `${WEATHER}?city=nyc` }),
      NOW + 1,
      TTL_MS,
    );
    assert.equal(decision.statusCode, 409);
    assert.equal(decision.grantAccess, false);
  });

  it("returns 409 and does not grant access on terms drift", () => {
    const other = { ...PAYLOAD, accepted: { ...PAYLOAD.accepted, amount: "999999" } };
    const decision = lookup(cached(fp()), fp({ payload: other }), NOW + 1, TTL_MS);
    assert.equal(decision.statusCode, 409);
    assert.equal(decision.grantAccess, false);
  });

  it("treats a missing stored fingerprint as conflict", () => {
    const decision = lookup({ timestamp: NOW, response: {} }, fp(), NOW + 1, TTL_MS);
    assert.equal(decision.statusCode, 409);
    assert.equal(decision.grantAccess, false);
  });

  it("misses an unknown payment ID", () => {
    const decision = lookup(undefined, fp(), NOW, TTL_MS);
    assert.equal(decision.kind, "miss");
    assert.equal(decision.grantAccess, false);
  });

  it("canonicalizes query parameter order", () => {
    assert.equal(fp({ url: `${WEATHER}?b=2&a=1` }), fp({ url: `${WEATHER}?a=1&b=2` }));
  });
});
