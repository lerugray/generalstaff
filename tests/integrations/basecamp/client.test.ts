import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import {
  parseNextLink,
  loadClientConfig,
} from "../../../src/integrations/basecamp/client";

const TEST_DIR = join(import.meta.dir, "..", "..", "fixtures", "basecamp_client_test");
const ENV_PATH = join(TEST_DIR, ".env");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("parseNextLink", () => {
  it("returns null for empty or missing header", () => {
    expect(parseNextLink(null)).toBeNull();
    expect(parseNextLink("")).toBeNull();
  });

  it("extracts next URL from a single-rel Link header", () => {
    expect(
      parseNextLink('<https://api.example.com/p?page=2>; rel="next"'),
    ).toBe("https://api.example.com/p?page=2");
  });

  it("extracts next URL when multiple rels are present", () => {
    const header =
      '<https://api.example.com/p?page=3>; rel="next", ' +
      '<https://api.example.com/p?page=1>; rel="prev", ' +
      '<https://api.example.com/p?page=1>; rel="first"';
    expect(parseNextLink(header)).toBe("https://api.example.com/p?page=3");
  });

  it("returns null when no next rel is present", () => {
    expect(
      parseNextLink('<https://api.example.com/p?page=1>; rel="prev"'),
    ).toBeNull();
  });

  it("tolerates angle brackets in unusual positions", () => {
    expect(
      parseNextLink('<https://api.example.com/x<y>z>; rel="next"'),
    ).not.toBeNull();
  });
});

describe("loadClientConfig", () => {
  it("throws a helpful error when BASECAMP_ACCOUNT_ID is missing", () => {
    writeFileSync(ENV_PATH, "BASECAMP_USER_AGENT=Test (t@e.com)\n");
    expect(() => loadClientConfig(ENV_PATH)).toThrow(
      /BASECAMP_ACCOUNT_ID/,
    );
  });

  it("defaults User-Agent when not set", () => {
    writeFileSync(ENV_PATH, "BASECAMP_ACCOUNT_ID=1234567\n");
    const config = loadClientConfig(ENV_PATH);
    expect(config.accountId).toBe("1234567");
    expect(config.userAgent).toContain("GeneralStaff");
  });

  it("uses custom User-Agent when set", () => {
    writeFileSync(
      ENV_PATH,
      "BASECAMP_ACCOUNT_ID=1234567\n" +
        "BASECAMP_USER_AGENT=MyApp/1.0 (me@example.com)\n",
    );
    const config = loadClientConfig(ENV_PATH);
    expect(config.userAgent).toBe("MyApp/1.0 (me@example.com)");
  });
});
