/**
 * Client extensions for querying Bazaar discovery resources
 */

import { HTTPFacilitatorClient } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { WithExtensions } from "../types";

/**
 * Parameters for listing discovery resources.
 * All parameters are optional and used for filtering/pagination.
 */
export interface ListDiscoveryResourcesParams {
  /**
   * Filter by protocol type (e.g., "http", "mcp").
   */
  type?: string;

  /**
   * Filter by payment recipient address.
   */
  payTo?: string;

  /**
   * Filter by payment scheme (e.g., "exact").
   */
  scheme?: string;

  /**
   * Filter by payment network (e.g., "eip155:8453").
   */
  network?: string;

  /**
   * Filter by extension key present on the discovered resource.
   */
  extensions?: string;

  /**
   * The number of discovered x402 resources to return per page.
   */
  limit?: number;

  /**
   * The offset of the first discovered x402 resource to return.
   */
  offset?: number;
}

/**
 * Parameters for searching discovery resources.
 */
export interface SearchDiscoveryResourcesParams {
  /**
   * Natural-language search query.
   */
  query: string;

  /**
   * Filter by protocol type (e.g., "http", "mcp").
   */
  type?: string;

  /**
   * Filter by payment recipient address.
   */
  payTo?: string;

  /**
   * Filter by payment scheme (e.g., "exact").
   */
  scheme?: string;

  /**
   * Filter by payment network (e.g., "eip155:8453").
   */
  network?: string;

  /**
   * Filter by extension key present on the discovered resource.
   */
  extensions?: string;

  /**
   * Advisory maximum number of results. The server may return fewer or ignore this.
   */
  limit?: number;

  /**
   * Advisory continuation cursor from a previous response. The server may ignore this.
   */
  cursor?: string;
}

/**
 * A discovered x402 resource from the bazaar.
 */
export interface DiscoveryResource {
  /** The URL or identifier of the discovered resource */
  resource: string;
  /** The protocol type of the resource (e.g., "http") */
  type: string;
  /** The x402 protocol version supported by this resource */
  x402Version: number;
  /** Array of accepted payment methods for this resource */
  accepts: PaymentRequirements[];
  /** ISO 8601 timestamp of when the resource was last updated */
  lastUpdated: string;
  /** Human-readable description of the resource */
  description?: string;
  /** MIME type of the resource response */
  mimeType?: string;
  /** Human-readable name for the service hosting the resource */
  serviceName?: string;
  /** Short topical tags for discovery search */
  tags?: string[];
  /** Absolute http(s) URL to a service icon */
  iconUrl?: string;
  /** Extension payloads echoed from discovery (e.g. bazaar info/schema) */
  extensions?: Record<string, unknown>;
}

/**
 * Response from listing discovery resources.
 */
export interface DiscoveryResourcesResponse {
  /** The x402 protocol version of this response */
  x402Version: number;
  /** The list of discovered resources */
  items: DiscoveryResource[];
  /** Pagination information for the response */
  pagination: {
    /** Maximum number of results returned */
    limit: number;
    /** Number of results skipped */
    offset: number;
    /** Total count of resources matching the query */
    total: number;
  };
}

/**
 * Response from searching discovery resources.
 */
export interface SearchDiscoveryResourcesResponse {
  /** The x402 protocol version of this response */
  x402Version: number;
  /** The list of matching discovered resources */
  resources: DiscoveryResource[];
  /** Whether additional matches were truncated by facilitator */
  partialResults?: boolean;
  /** Optional pagination details when a paginated response is returned */
  pagination?: {
    /** Number of results in this page */
    limit: number;
    /** Continuation cursor for the next page; may be null */
    cursor: string | null;
  } | null;
}

/**
 * Inspection badge on a published route list. Only `"verified"` rows are
 * used as matches; `"drift"` and `"unverified"` never keep a Bazaar row.
 */
export type InspectedRouteBadge = "verified" | "drift" | "unverified";

/**
 * One row of a published inspected-route document (origin + path + badge).
 * Extra fields on a real feed are ignored.
 */
export interface InspectedRoute {
  origin: string;
  route: string;
  badge: InspectedRouteBadge;
}

/**
 * Published inspected-route document. Callers fetch this JSON themselves
 * and pass it in; this helper does not retrieve or rank anything.
 */
export interface InspectedRouteFeed {
  routes: InspectedRoute[];
}

/**
 * Origin + path identity for a resource URL. Host is case-insensitive;
 * trailing slashes, query strings, and fragments are ignored.
 *
 * @param url - Absolute resource URL from a Bazaar row
 * @returns Canonical origin+path, or undefined when `url` is not a valid URL
 */
function resourceIdentity(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}`;
  } catch {
    return undefined;
  }
}

/**
 * Origin + path identity for one inspected-route row.
 *
 * @param origin - Absolute origin (scheme + host)
 * @param route - Path beginning with `/`
 * @returns Canonical origin+path, or undefined when the pair is not a valid URL
 */
function inspectedIdentity(origin: string, route: string): string | undefined {
  try {
    const originUrl = origin.endsWith("/") ? origin : `${origin}/`;
    return resourceIdentity(new URL(route, originUrl).href);
  } catch {
    return undefined;
  }
}

/**
 * Keep Bazaar discovery rows whose resource URL matches a verified
 * inspected route. Does not reorder remaining rows and does not change
 * how the facilitator ranks search hits.
 *
 * @param items - Bazaar `listResources` items or `search` resources
 * @param feed - Published inspected-route document (`origin`, `route`, `badge`)
 * @returns Rows whose URL matches a `badge: "verified"` route, in original order
 *
 * @example
 * ```ts
 * const listed = await client.extensions.bazaar.listResources({ type: "http" });
 * const kept = filterDiscoveryResources(listed.items, inspectedFeed);
 * ```
 */
export function filterDiscoveryResources(
  items: readonly DiscoveryResource[],
  feed: InspectedRouteFeed,
): DiscoveryResource[] {
  if (!Array.isArray(feed?.routes)) {
    throw new Error("inspected route feed must include a routes array");
  }

  const allowed = new Set<string>();
  for (const row of feed.routes) {
    if (row.badge !== "verified") continue;
    const id = inspectedIdentity(row.origin, row.route);
    if (id) allowed.add(id);
  }

  return items.filter(item => {
    const id = resourceIdentity(item.resource);
    return id !== undefined && allowed.has(id);
  });
}

/**
 * Bazaar client extension interface providing discovery query functionality.
 */
export interface BazaarClientExtension {
  bazaar: {
    /**
     * List x402 discovery resources from the bazaar.
     *
     * @param params - Optional filtering and pagination parameters
     * @returns A promise resolving to the discovery resources response
     */
    listResources(params?: ListDiscoveryResourcesParams): Promise<DiscoveryResourcesResponse>;

    /**
     * Search x402 discovery resources from the bazaar using a natural-language query.
     *
     * Pagination is optional: facilitators may ignore `limit` and `cursor`, or include
     * `response.pagination` when pagination is used.
     *
     * @param params - Search parameters including the required query string
     * @returns A promise resolving to the search response
     */
    search(params: SearchDiscoveryResourcesParams): Promise<SearchDiscoveryResourcesResponse>;
  };
}

/**
 * Extends a facilitator client with Bazaar discovery query functionality.
 * Preserves and merges with any existing extensions from prior chaining.
 *
 * @param client - The facilitator client to extend
 * @returns The client extended with bazaar discovery capabilities
 *
 * @example
 * ```ts
 * // Basic usage
 * const client = withBazaar(new HTTPFacilitatorClient());
 * const resources = await client.extensions.bazaar.listResources({ type: "http" });
 *
 * // Search
 * const results = await client.extensions.bazaar.search({ query: "weather APIs" });
 *
 * // Keep rows that match a verified inspected-route document
 * const kept = filterDiscoveryResources(results.resources, inspectedFeed);
 *
 * // Chaining with other extensions
 * const client = withBazaar(withOtherExtension(new HTTPFacilitatorClient()));
 * await client.extensions.other.someMethod();
 * await client.extensions.bazaar.listResources();
 * ```
 */
export function withBazaar<T extends HTTPFacilitatorClient>(
  client: T,
): WithExtensions<T, BazaarClientExtension> {
  // Preserve any existing extensions from prior chaining
  const existingExtensions =
    (client as T & { extensions?: Record<string, unknown> }).extensions ?? {};

  const extended = client as WithExtensions<T, BazaarClientExtension>;

  extended.extensions = {
    ...existingExtensions,
    bazaar: {
      async listResources(
        params?: ListDiscoveryResourcesParams,
      ): Promise<DiscoveryResourcesResponse> {
        let headers: Record<string, string> = {
          "Content-Type": "application/json",
        };

        const authHeaders = await client.createAuthHeaders("bazaar");
        headers = { ...headers, ...authHeaders.headers };

        const queryParams = new URLSearchParams();
        if (params?.type !== undefined) {
          queryParams.set("type", params.type);
        }
        if (params?.payTo !== undefined) {
          queryParams.set("payTo", params.payTo);
        }
        if (params?.scheme !== undefined) {
          queryParams.set("scheme", params.scheme);
        }
        if (params?.network !== undefined) {
          queryParams.set("network", params.network);
        }
        if (params?.extensions !== undefined) {
          queryParams.set("extensions", params.extensions);
        }
        if (params?.limit !== undefined) {
          queryParams.set("limit", params.limit.toString());
        }
        if (params?.offset !== undefined) {
          queryParams.set("offset", params.offset.toString());
        }

        const queryString = queryParams.toString();
        const endpoint = `${client.url}/discovery/resources${queryString ? `?${queryString}` : ""}`;

        const response = await fetch(endpoint, {
          method: "GET",
          headers,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => response.statusText);
          throw new Error(
            `Facilitator listDiscoveryResources failed (${response.status}): ${errorText}`,
          );
        }

        return (await response.json()) as DiscoveryResourcesResponse;
      },

      async search(
        params: SearchDiscoveryResourcesParams,
      ): Promise<SearchDiscoveryResourcesResponse> {
        let headers: Record<string, string> = {
          "Content-Type": "application/json",
        };

        const authHeaders = await client.createAuthHeaders("bazaar");
        headers = { ...headers, ...authHeaders.headers };

        const queryParams = new URLSearchParams();
        queryParams.set("query", params.query);
        if (params.type !== undefined) {
          queryParams.set("type", params.type);
        }
        if (params.payTo !== undefined) {
          queryParams.set("payTo", params.payTo);
        }
        if (params.scheme !== undefined) {
          queryParams.set("scheme", params.scheme);
        }
        if (params.network !== undefined) {
          queryParams.set("network", params.network);
        }
        if (params.extensions !== undefined) {
          queryParams.set("extensions", params.extensions);
        }
        if (params.limit !== undefined) {
          queryParams.set("limit", params.limit.toString());
        }
        if (params.cursor !== undefined) {
          queryParams.set("cursor", params.cursor);
        }

        const endpoint = `${client.url}/discovery/search?${queryParams.toString()}`;

        const response = await fetch(endpoint, {
          method: "GET",
          headers,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => response.statusText);
          throw new Error(
            `Facilitator searchDiscoveryResources failed (${response.status}): ${errorText}`,
          );
        }

        return (await response.json()) as SearchDiscoveryResourcesResponse;
      },
    },
  } as WithExtensions<T, BazaarClientExtension>["extensions"];

  return extended;
}
