"""Bind a payment identifier to the HTTP request, not the payment payload.

Fingerprint covers HTTP method, canonical path+query, raw body SHA-256, and
accepted terms (scheme, network, asset, amount, payTo). Same payment ID with a
different fingerprint is a conflict: HTTP 409, grant_access False.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit

HIT = "hit"
CONFLICT = "conflict"
MISS = "miss"
EXPIRED = "expired"

CONFLICT_MESSAGE = "payment identifier already used with different request"


def canonical_request_url(url: str) -> str:
    parts = urlsplit(url)
    query = urlencode(sorted(parse_qsl(parts.query, keep_blank_values=True)))
    path = parts.path or "/"
    return f"{path}?{query}" if query else path


def body_sha256(body: bytes | bytearray | memoryview | str | None) -> str:
    if body is None:
        data = b""
    elif isinstance(body, str):
        data = body.encode("utf-8")
    else:
        data = bytes(body)
    return hashlib.sha256(data).hexdigest()


def _as_mapping(value: Any) -> Mapping[str, Any]:
    if value is None:
        return {}
    if isinstance(value, Mapping):
        return value
    if hasattr(value, "model_dump"):
        dumped = value.model_dump(by_alias=True)
        if isinstance(dumped, Mapping):
            return dumped
    return {}


def payment_terms(payload: Any) -> dict[str, str]:
    accepted = _as_mapping(_as_mapping(payload).get("accepted"))
    pay_to = accepted.get("payTo", accepted.get("pay_to", ""))
    return {
        "scheme": str(accepted.get("scheme") or ""),
        "network": str(accepted.get("network") or ""),
        "asset": str(accepted.get("asset") or ""),
        "amount": str(accepted.get("amount") or ""),
        "payTo": str(pay_to or ""),
    }


def request_fingerprint(
    *,
    method: str,
    url: str,
    body: bytes | bytearray | memoryview | str | None,
    payload: Any,
) -> str:
    material = {
        "bodySha256": body_sha256(body),
        "method": (method or "").upper(),
        "url": canonical_request_url(url),
        **payment_terms(payload),
    }
    canonical = json.dumps(material, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class CacheDecision:
    kind: str
    status_code: int | None
    grant_access: bool


def lookup(
    cache: Mapping[str, Any],
    *,
    payment_id: str,
    fingerprint: str,
    now: float,
    ttl_seconds: float,
) -> CacheDecision:
    cached = cache.get(payment_id)
    if cached is None:
        return CacheDecision(MISS, None, False)
    if isinstance(cached, Mapping):
        timestamp = float(cached["timestamp"])
        cached_fp = cached.get("fingerprint")
    else:
        timestamp = float(cached.timestamp)
        cached_fp = getattr(cached, "fingerprint", None)
    if now - timestamp >= ttl_seconds:
        return CacheDecision(EXPIRED, None, False)
    if not cached_fp or cached_fp != fingerprint:
        return CacheDecision(CONFLICT, 409, False)
    return CacheDecision(HIT, 200, True)
