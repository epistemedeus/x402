"""Credential-free tests for request-bound payment-identifier lookup.

No wallet, chain, facilitator, or live payment.
"""

from __future__ import annotations

import unittest

from request_binding import lookup, request_fingerprint

PAYMENT_ID = "pay_aaaaaaaaaaaaaaaa"
TTL = 3600.0
NOW = 1_000.0

PAYLOAD = {
    "x402Version": 2,
    "accepted": {
        "scheme": "exact",
        "network": "eip155:84532",
        "asset": "0x0000000000000000000000000000000000000001",
        "amount": "1000",
        "payTo": "0x0000000000000000000000000000000000000002",
    },
    "payload": {"signature": "0xsig"},
    "extensions": {
        "payment-identifier": {"info": {"id": PAYMENT_ID, "required": False}},
    },
}

WEATHER = "http://localhost:4022/weather"
FORECAST = "http://localhost:4022/forecast"


def fp(*, method="GET", url=WEATHER, body=b"", payload=PAYLOAD) -> str:
    return request_fingerprint(method=method, url=url, body=body, payload=payload)


def cache_for(fingerprint: str) -> dict:
    return {
        PAYMENT_ID: {
            "timestamp": NOW,
            "fingerprint": fingerprint,
            "response": {"report": {"weather": "sunny"}},
        }
    }


class RequestBoundLookup(unittest.TestCase):
    def test_identical_retry_is_hit(self) -> None:
        decision = lookup(
            cache_for(fp()),
            payment_id=PAYMENT_ID,
            fingerprint=fp(),
            now=NOW + 1,
            ttl_seconds=TTL,
        )
        self.assertEqual(decision.kind, "hit")
        self.assertEqual(decision.status_code, 200)
        self.assertTrue(decision.grant_access)

    def test_method_drift_is_409_without_access(self) -> None:
        decision = lookup(
            cache_for(fp(method="GET")),
            payment_id=PAYMENT_ID,
            fingerprint=fp(method="POST"),
            now=NOW + 1,
            ttl_seconds=TTL,
        )
        self.assertEqual(decision.status_code, 409)
        self.assertFalse(decision.grant_access)

    def test_path_drift_is_409_without_access(self) -> None:
        decision = lookup(
            cache_for(fp(url=WEATHER)),
            payment_id=PAYMENT_ID,
            fingerprint=fp(url=FORECAST),
            now=NOW + 1,
            ttl_seconds=TTL,
        )
        self.assertEqual(decision.status_code, 409)
        self.assertFalse(decision.grant_access)

    def test_body_drift_is_409_without_access(self) -> None:
        decision = lookup(
            cache_for(fp(body=b"")),
            payment_id=PAYMENT_ID,
            fingerprint=fp(body=b'{"city":"nyc"}'),
            now=NOW + 1,
            ttl_seconds=TTL,
        )
        self.assertEqual(decision.status_code, 409)
        self.assertFalse(decision.grant_access)

    def test_query_drift_is_409_without_access(self) -> None:
        decision = lookup(
            cache_for(fp(url=WEATHER)),
            payment_id=PAYMENT_ID,
            fingerprint=fp(url=WEATHER + "?city=nyc"),
            now=NOW + 1,
            ttl_seconds=TTL,
        )
        self.assertEqual(decision.status_code, 409)
        self.assertFalse(decision.grant_access)

    def test_terms_drift_is_409_without_access(self) -> None:
        other = {**PAYLOAD, "accepted": {**PAYLOAD["accepted"], "amount": "999999"}}
        decision = lookup(
            cache_for(fp()),
            payment_id=PAYMENT_ID,
            fingerprint=fp(payload=other),
            now=NOW + 1,
            ttl_seconds=TTL,
        )
        self.assertEqual(decision.status_code, 409)
        self.assertFalse(decision.grant_access)

    def test_missing_fingerprint_is_conflict(self) -> None:
        cache = {PAYMENT_ID: {"timestamp": NOW, "response": {}}}
        decision = lookup(
            cache,
            payment_id=PAYMENT_ID,
            fingerprint=fp(),
            now=NOW + 1,
            ttl_seconds=TTL,
        )
        self.assertEqual(decision.status_code, 409)
        self.assertFalse(decision.grant_access)

    def test_unknown_id_is_miss(self) -> None:
        decision = lookup(
            {}, payment_id=PAYMENT_ID, fingerprint=fp(), now=NOW, ttl_seconds=TTL
        )
        self.assertEqual(decision.kind, "miss")
        self.assertFalse(decision.grant_access)

    def test_query_param_order_is_stable(self) -> None:
        self.assertEqual(fp(url=WEATHER + "?b=2&a=1"), fp(url=WEATHER + "?a=1&b=2"))


if __name__ == "__main__":
    unittest.main()
