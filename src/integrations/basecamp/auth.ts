// Basecamp 4 OAuth2 browser-callback flow.
//
// One-shot setup: opens the user's browser to 37signals Launchpad,
// listens on localhost for the callback, exchanges the verification
// code for access + refresh tokens, writes them to the caller's .env.
//
// See https://github.com/basecamp/bc3-api/blob/master/sections/authentication.md
// for the authoritative protocol. This implementation hews to the
// "OAuth 2 from scratch" section.

import { randomBytes } from "node:crypto";
import { updateEnv, readEnv, type EnvMap } from "./env";

const AUTHORIZE_URL = "https://launchpad.37signals.com/authorization/new";
const TOKEN_URL = "https://launchpad.37signals.com/authorization/token";
const AUTHZ_CHECK_URL = "https://launchpad.37signals.com/authorization.json";

// Timeout for the browser round-trip. Generous — users get prompted,
// may switch tabs, read the consent screen.
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  userAgent: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix seconds
}

export interface Account {
  id: number;
  name: string;
  href: string;
}

export interface AuthResult {
  tokens: TokenSet;
  accounts: Account[];
}

export function loadAuthConfig(envPath: string): AuthConfig {
  const env = readEnv(envPath);
  return {
    clientId: requireEnv(env, "BASECAMP_CLIENT_ID"),
    clientSecret: requireEnv(env, "BASECAMP_CLIENT_SECRET"),
    redirectUri:
      env["BASECAMP_REDIRECT_URI"] || "http://localhost:8765/oauth",
    userAgent:
      env["BASECAMP_USER_AGENT"] ||
      "GeneralStaff/BasecampIntegration (no-contact)",
  };
}

function requireEnv(env: EnvMap, key: string): string {
  const v = env[key];
  if (!v) {
    throw new Error(
      `Missing ${key} in .env. ` +
        `Run \`generalstaff integrations basecamp auth --help\` for setup instructions.`,
    );
  }
  return v;
}

interface CallbackResult {
  code?: string;
  error?: string;
}

async function waitForCallback(
  host: string,
  port: number,
  expectedState: string,
): Promise<CallbackResult> {
  let resolve!: (result: CallbackResult) => void;
  const settled = new Promise<CallbackResult>((r) => {
    resolve = r;
  });
  let server: ReturnType<typeof Bun.serve> | undefined;

  const timeout = setTimeout(() => {
    resolve({ error: "timeout" });
  }, CALLBACK_TIMEOUT_MS);

  server = Bun.serve({
    hostname: host,
    port,
    fetch(req): Response {
      const url = new URL(req.url);
      if (url.pathname !== "/oauth") {
        return new Response("Not found", { status: 404 });
      }
      const code = url.searchParams.get("code") || "";
      const state = url.searchParams.get("state") || "";
      const error = url.searchParams.get("error") || "";

      let body: string;
      let result: CallbackResult;
      if (error) {
        result = { error };
        body = `<h1>Error</h1><p>Basecamp returned: ${escapeHtml(error)}</p>`;
      } else if (state !== expectedState) {
        result = { error: "state_mismatch" };
        body =
          "<h1>Error</h1><p>State parameter mismatch. Aborting for security.</p>";
      } else if (!code) {
        result = { error: "no_code" };
        body = "<h1>Error</h1><p>No authorization code in callback.</p>";
      } else {
        result = { code };
        body =
          "<h1>Success</h1>" +
          "<p>Authorization captured. You can close this tab &mdash; " +
          "the CLI will finish the token exchange.</p>";
      }

      queueMicrotask(() => resolve(result));
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
    error(err): Response {
      // Absorb per-request errors — avoid crashing before the callback arrives.
      return new Response(`Internal error: ${err.message}`, { status: 500 });
    },
  });

  try {
    return await settled;
  } finally {
    clearTimeout(timeout);
    server?.stop(true);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function openUrl(url: string): Promise<void> {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
    } else if (platform === "win32") {
      // `start` is a cmd built-in; must go through cmd.exe
      Bun.spawn(["cmd.exe", "/c", "start", "", url], {
        stdout: "ignore",
        stderr: "ignore",
      });
    } else {
      Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" });
    }
  } catch {
    // Non-fatal — the URL is printed to stdout anyway
  }
}

async function exchangeCodeForToken(
  code: string,
  config: AuthConfig,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const body = new URLSearchParams({
    type: "web_server",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    code,
  });
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token exchange failed (${resp.status}): ${text}`);
  }
  return resp.json() as Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }>;
}

export async function fetchAuthorizationInfo(
  accessToken: string,
  userAgent: string,
): Promise<{ accounts: Account[]; identity?: unknown }> {
  const resp = await fetch(AUTHZ_CHECK_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": userAgent,
      Accept: "application/json",
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Authorization check failed (${resp.status}): ${text}`);
  }
  const data = (await resp.json()) as { accounts?: Account[]; identity?: unknown };
  return { accounts: data.accounts ?? [], identity: data.identity };
}

export interface RunAuthOptions {
  envPath: string;
  onAuthUrl?: (url: string) => void; // for tests to intercept browser-open
  skipOpenBrowser?: boolean;
}

export async function runAuth(options: RunAuthOptions): Promise<AuthResult> {
  const config = loadAuthConfig(options.envPath);
  const redirect = new URL(config.redirectUri);
  const host = redirect.hostname || "localhost";
  const port = redirect.port ? parseInt(redirect.port, 10) : 8765;

  const state = randomBytes(16).toString("base64url");
  const authParams = new URLSearchParams({
    type: "web_server",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    state,
  });
  const authUrl = `${AUTHORIZE_URL}?${authParams.toString()}`;

  if (options.onAuthUrl) options.onAuthUrl(authUrl);
  if (!options.skipOpenBrowser) await openUrl(authUrl);

  const callback = await waitForCallback(host, port, state);
  if (callback.error) {
    throw new Error(`Authorization failed: ${callback.error}`);
  }
  if (!callback.code) {
    throw new Error("Authorization succeeded without a code (unexpected).");
  }

  const tokenResp = await exchangeCodeForToken(callback.code, config);
  const tokens: TokenSet = {
    accessToken: tokenResp.access_token,
    refreshToken: tokenResp.refresh_token,
    expiresAt: Math.floor(Date.now() / 1000) + tokenResp.expires_in,
  };

  const info = await fetchAuthorizationInfo(tokens.accessToken, config.userAgent);
  if (info.accounts.length === 0) {
    throw new Error(
      "Token works but reports 0 accessible accounts. " +
        "Was the app approved for a Basecamp 4 account?",
    );
  }

  const firstAccount = info.accounts[0];
  if (!firstAccount) {
    throw new Error("Accounts list non-empty but first entry missing — unexpected.");
  }
  updateEnv(options.envPath, {
    BASECAMP_ACCESS_TOKEN: tokens.accessToken,
    BASECAMP_REFRESH_TOKEN: tokens.refreshToken,
    BASECAMP_ACCOUNT_ID: String(firstAccount.id),
    BASECAMP_TOKEN_EXPIRES_AT: String(tokens.expiresAt),
  });

  return { tokens, accounts: info.accounts };
}

export async function refreshAccessToken(
  envPath: string,
): Promise<TokenSet> {
  const env = readEnv(envPath);
  const refreshToken = requireEnv(env, "BASECAMP_REFRESH_TOKEN");
  const clientId = requireEnv(env, "BASECAMP_CLIENT_ID");
  const clientSecret = requireEnv(env, "BASECAMP_CLIENT_SECRET");

  const body = new URLSearchParams({
    type: "refresh",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token refresh failed (${resp.status}): ${text}`);
  }
  const tokenResp = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  const tokens: TokenSet = {
    accessToken: tokenResp.access_token,
    // Basecamp may or may not rotate the refresh token; keep the old
    // if not returned.
    refreshToken: tokenResp.refresh_token ?? refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + tokenResp.expires_in,
  };

  const updates: EnvMap = {
    BASECAMP_ACCESS_TOKEN: tokens.accessToken,
    BASECAMP_TOKEN_EXPIRES_AT: String(tokens.expiresAt),
  };
  if (tokenResp.refresh_token) {
    updates["BASECAMP_REFRESH_TOKEN"] = tokenResp.refresh_token;
  }
  updateEnv(envPath, updates);

  return tokens;
}

export function isTokenExpired(envPath: string, skewSeconds = 60): boolean {
  const env = readEnv(envPath);
  const expiresAt = parseInt(env["BASECAMP_TOKEN_EXPIRES_AT"] || "0", 10);
  if (!expiresAt) return true;
  return expiresAt - Math.floor(Date.now() / 1000) < skewSeconds;
}

export async function ensureFreshToken(envPath: string): Promise<string> {
  if (isTokenExpired(envPath)) {
    await refreshAccessToken(envPath);
  }
  const env = readEnv(envPath);
  return requireEnv(env, "BASECAMP_ACCESS_TOKEN");
}
