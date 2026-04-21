import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import {
  loadAuthConfig,
  isTokenExpired,
} from "../../../src/integrations/basecamp/auth";
import { readEnv } from "../../../src/integrations/basecamp/env";

const TEST_DIR = join(import.meta.dir, "..", "..", "fixtures", "basecamp_auth_test");
const ENV_PATH = join(TEST_DIR, ".env");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("loadAuthConfig", () => {
  it("throws when BASECAMP_CLIENT_ID is missing", () => {
    writeFileSync(ENV_PATH, "BASECAMP_CLIENT_SECRET=secret\n");
    expect(() => loadAuthConfig(ENV_PATH)).toThrow(/BASECAMP_CLIENT_ID/);
  });

  it("throws when BASECAMP_CLIENT_SECRET is missing", () => {
    writeFileSync(ENV_PATH, "BASECAMP_CLIENT_ID=abc\n");
    expect(() => loadAuthConfig(ENV_PATH)).toThrow(/BASECAMP_CLIENT_SECRET/);
  });

  it("defaults redirect_uri to localhost:8765 when not set", () => {
    writeFileSync(
      ENV_PATH,
      "BASECAMP_CLIENT_ID=abc\nBASECAMP_CLIENT_SECRET=xyz\n",
    );
    const config = loadAuthConfig(ENV_PATH);
    expect(config.redirectUri).toBe("http://localhost:8765/oauth");
  });

  it("honors custom redirect_uri", () => {
    writeFileSync(
      ENV_PATH,
      "BASECAMP_CLIENT_ID=abc\n" +
        "BASECAMP_CLIENT_SECRET=xyz\n" +
        "BASECAMP_REDIRECT_URI=http://localhost:9999/callback\n",
    );
    const config = loadAuthConfig(ENV_PATH);
    expect(config.redirectUri).toBe("http://localhost:9999/callback");
  });

  it("defaults User-Agent when absent", () => {
    writeFileSync(
      ENV_PATH,
      "BASECAMP_CLIENT_ID=abc\nBASECAMP_CLIENT_SECRET=xyz\n",
    );
    const config = loadAuthConfig(ENV_PATH);
    expect(config.userAgent).toContain("GeneralStaff");
  });
});

describe("isTokenExpired", () => {
  it("returns true when no expires_at is set", () => {
    writeFileSync(ENV_PATH, "BASECAMP_ACCESS_TOKEN=abc\n");
    expect(isTokenExpired(ENV_PATH)).toBe(true);
  });

  it("returns true when expires_at is in the past", () => {
    const pastTimestamp = Math.floor(Date.now() / 1000) - 3600;
    writeFileSync(
      ENV_PATH,
      `BASECAMP_ACCESS_TOKEN=abc\nBASECAMP_TOKEN_EXPIRES_AT=${pastTimestamp}\n`,
    );
    expect(isTokenExpired(ENV_PATH)).toBe(true);
  });

  it("returns true when expires_at is within the skew window", () => {
    const soonTimestamp = Math.floor(Date.now() / 1000) + 30;
    writeFileSync(
      ENV_PATH,
      `BASECAMP_ACCESS_TOKEN=abc\nBASECAMP_TOKEN_EXPIRES_AT=${soonTimestamp}\n`,
    );
    // Default skew is 60s; 30s from now is inside that window → expired
    expect(isTokenExpired(ENV_PATH)).toBe(true);
  });

  it("returns false when expires_at is safely in the future", () => {
    const futureTimestamp = Math.floor(Date.now() / 1000) + 7200;
    writeFileSync(
      ENV_PATH,
      `BASECAMP_ACCESS_TOKEN=abc\nBASECAMP_TOKEN_EXPIRES_AT=${futureTimestamp}\n`,
    );
    expect(isTokenExpired(ENV_PATH)).toBe(false);
  });

  it("respects custom skew parameter", () => {
    const timestamp = Math.floor(Date.now() / 1000) + 100;
    writeFileSync(
      ENV_PATH,
      `BASECAMP_ACCESS_TOKEN=abc\nBASECAMP_TOKEN_EXPIRES_AT=${timestamp}\n`,
    );
    expect(isTokenExpired(ENV_PATH, 50)).toBe(false);
    expect(isTokenExpired(ENV_PATH, 200)).toBe(true);
  });
});

describe("readEnv (integration-level sanity)", () => {
  it("roundtrip: write auth-shaped env and re-read it", () => {
    writeFileSync(
      ENV_PATH,
      "# preamble\n" +
        "BASECAMP_CLIENT_ID=id-123\n" +
        "BASECAMP_CLIENT_SECRET=sec-456\n" +
        "BASECAMP_REDIRECT_URI=http://localhost:8765/oauth\n" +
        "BASECAMP_USER_AGENT=TestApp (t@e.com)\n",
    );
    const env = readEnv(ENV_PATH);
    expect(env["BASECAMP_CLIENT_ID"]).toBe("id-123");
    expect(env["BASECAMP_CLIENT_SECRET"]).toBe("sec-456");
    expect(env["BASECAMP_REDIRECT_URI"]).toBe("http://localhost:8765/oauth");
    expect(env["BASECAMP_USER_AGENT"]).toBe("TestApp (t@e.com)");
  });
});
