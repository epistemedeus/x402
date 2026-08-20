import { createHash } from "crypto";

export const CONFLICT_MESSAGE = "payment identifier already used with different request";

export type PaymentTermsSource = {
  accepted?: {
    scheme?: string;
    network?: string;
    asset?: string;
    amount?: string;
    payTo?: string;
    pay_to?: string;
  };
};

export type CacheDecision =
  | { kind: "hit"; statusCode: 200; grantAccess: true }
  | { kind: "conflict"; statusCode: 409; grantAccess: false }
  | { kind: "miss"; statusCode: null; grantAccess: false }
  | { kind: "expired"; statusCode: null; grantAccess: false };

/**
 * Canonical path and sorted query, without host or fragment.
 *
 * @param url - Absolute URL or path with optional query
 * @returns Canonical request target
 */
export function canonicalRequestUrl(url: string): string {
  const parsed = new URL(url, "http://localhost");
  parsed.searchParams.sort();
  return parsed.search ? `${parsed.pathname}${parsed.search}` : parsed.pathname;
}

/**
 * SHA-256 hex digest of the raw request body. Missing bodies hash as empty bytes.
 *
 * @param body - Raw request body
 * @returns Hex digest
 */
export function bodySha256(body: Buffer | string | null | undefined): string {
  const data = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body);
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Fingerprint the HTTP request plus accepted payment terms.
 *
 * Hashing the payment payload or payment header is not request binding: the same
 * signed payload can be replayed against a different method, path, or body.
 *
 * @param input - HTTP method, URL, raw body, and payment payload terms
 * @returns SHA-256 hex digest
 */
export function requestFingerprint(input: {
  method: string;
  url: string;
  body?: Buffer | string | null;
  payload?: PaymentTermsSource | null;
}): string {
  const accepted = input.payload?.accepted ?? {};
  const material = {
    amount: String(accepted.amount ?? ""),
    asset: String(accepted.asset ?? ""),
    bodySha256: bodySha256(input.body),
    method: (input.method || "").toUpperCase(),
    network: String(accepted.network ?? ""),
    payTo: String(accepted.payTo ?? accepted.pay_to ?? ""),
    scheme: String(accepted.scheme ?? ""),
    url: canonicalRequestUrl(input.url),
  };
  const keys = Object.keys(material).sort();
  return createHash("sha256").update(JSON.stringify(material, keys)).digest("hex");
}

/**
 * Look up a cached payment ID against the current request fingerprint.
 *
 * A conflict never grants access.
 *
 * @param cached - Existing cache entry, if any
 * @param fingerprint - Fingerprint of the incoming HTTP request
 * @param now - Current time in milliseconds
 * @param ttlMs - Cache time to live in milliseconds
 * @returns Cache decision
 */
export function lookup(
  cached: { timestamp: number; fingerprint?: string } | undefined,
  fingerprint: string,
  now: number,
  ttlMs: number,
): CacheDecision {
  if (!cached) {
    return { kind: "miss", statusCode: null, grantAccess: false };
  }
  if (now - cached.timestamp >= ttlMs) {
    return { kind: "expired", statusCode: null, grantAccess: false };
  }
  if (!cached.fingerprint || cached.fingerprint !== fingerprint) {
    return { kind: "conflict", statusCode: 409, grantAccess: false };
  }
  return { kind: "hit", statusCode: 200, grantAccess: true };
}
