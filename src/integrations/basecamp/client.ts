// Basecamp 4 HTTP client — auto-refreshing access token, User-Agent
// enforcement, Link-header pagination. Thin wrapper around fetch;
// callers build their own per-endpoint logic on top.

import { ensureFreshToken, fetchAuthorizationInfo } from "./auth";
import { readEnv } from "./env";

export interface ClientConfig {
  envPath: string;
  accountId: string;
  userAgent: string;
  baseUrl?: string; // override for testing; default https://3.basecampapi.com
}

export function loadClientConfig(envPath: string): ClientConfig {
  const env = readEnv(envPath);
  const accountId = env["BASECAMP_ACCOUNT_ID"];
  if (!accountId) {
    throw new Error(
      "Missing BASECAMP_ACCOUNT_ID in .env. Run `generalstaff integrations basecamp auth` first.",
    );
  }
  const userAgent =
    env["BASECAMP_USER_AGENT"] ||
    "GeneralStaff/BasecampIntegration (no-contact)";
  return { envPath, accountId, userAgent };
}

/**
 * GET an endpoint under the account's base URL. Auto-refreshes the
 * access token if expired. Honors pagination via the Link: <url>;
 * rel="next" header — collects all pages into a single array when the
 * response body is an array, or returns the first page verbatim for
 * object responses.
 */
export async function get(
  config: ClientConfig,
  endpoint: string,
): Promise<unknown> {
  const accessToken = await ensureFreshToken(config.envPath);
  const base = config.baseUrl ?? "https://3.basecampapi.com";
  const firstUrl = `${base}/${config.accountId}/${endpoint.replace(/^\//, "")}`;

  const firstResp = await fetchWithAuth(firstUrl, accessToken, config.userAgent);
  const firstData = await firstResp.json();

  // Non-array responses don't paginate meaningfully — return as-is.
  if (!Array.isArray(firstData)) return firstData;

  const collected: unknown[] = [...firstData];
  let nextUrl = parseNextLink(firstResp.headers.get("Link"));
  while (nextUrl) {
    const token = await ensureFreshToken(config.envPath);
    const resp = await fetchWithAuth(nextUrl, token, config.userAgent);
    const data = await resp.json();
    if (Array.isArray(data)) collected.push(...data);
    nextUrl = parseNextLink(resp.headers.get("Link"));
  }
  return collected;
}

async function fetchWithAuth(
  url: string,
  accessToken: string,
  userAgent: string,
): Promise<Response> {
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": userAgent,
      Accept: "application/json",
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "<unreadable body>");
    throw new Error(
      `Basecamp GET ${url} failed (${resp.status}): ${text.slice(0, 500)}`,
    );
  }
  return resp;
}

export function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  // RFC5988 Link header: <url>; rel="next", <url2>; rel="prev"
  for (const part of header.split(",")) {
    if (part.includes('rel="next"')) {
      const start = part.indexOf("<");
      const end = part.indexOf(">");
      if (start >= 0 && end > start) return part.slice(start + 1, end);
    }
  }
  return null;
}

export interface Project {
  id: number;
  name: string;
  status: string;
  created_at?: string;
}

export async function listProjects(config: ClientConfig): Promise<Project[]> {
  const data = await get(config, "projects.json");
  return (Array.isArray(data) ? data : []) as Project[];
}

/**
 * Call /authorization.json on behalf of whoever the current token
 * belongs to. Useful for validating that a freshly-refreshed token
 * actually works.
 */
export async function whoAmI(config: ClientConfig): Promise<{
  accounts: Array<{ id: number; name: string; href: string }>;
  identity?: unknown;
}> {
  const accessToken = await ensureFreshToken(config.envPath);
  return fetchAuthorizationInfo(accessToken, config.userAgent);
}
