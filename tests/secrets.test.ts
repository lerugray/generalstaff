import { describe, expect, it } from "bun:test";
import {
  formatSecretRedactionWarning,
  redactSecrets,
} from "../src/secrets";

describe("redactSecrets", () => {
  it("masks common provider token prefixes without retaining the value", () => {
    // Fixtures are assembled at runtime so no literal in this file matches a
    // secret scanner (GitHub push protection flags realistic literals).
    const values = [
      ["AKIA", "ABCDEFGHIJKLMNOP"].join(""),
      ["ghp_", "abcdefghijklmnopqrstuvwxyz123456"].join(""),
      ["sk-proj-", "abcdefghijklmnopqrstuvwxyz123456"].join(""),
      ["sk-ant-", "abcdefghijklmnopqrstuvwxyz123456"].join(""),
      ["xoxb-", "1234567890-abcdefghijklmnopqrstuv"].join(""),
    ];
    const result = redactSecrets(values.join("\n"));
    for (const value of values) {
      expect(result.redacted).not.toContain(value);
    }
    expect(result.hits.reduce((sum, hit) => sum + hit.count, 0)).toBe(5);
  });

  it("masks PEM blocks as one finding", () => {
    const pem = [
      "-----BEGIN PRIVATE KEY-----",
      "VGhpcyBpcyBhIGZha2UgcHJpdmF0ZSBrZXk=",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const result = redactSecrets(`before\n${pem}\nafter`);
    expect(result.redacted).toBe(`before\n[REDACTED]\nafter`);
    expect(result.hits).toEqual([{ kind: "pem_private_key", count: 1 }]);
  });

  it("masks high-entropy export values and secret-named assignments", () => {
    const exported = "export SESSION_BLOB=AbCdEf0123456789+/AbCdEf";
    const assigned = '+api_key="AbCdEf0123456789AbCdEf"';
    const result = redactSecrets(`${exported}\n${assigned}\nexport MODE=development`);
    expect(result.redacted).toContain("export SESSION_BLOB=[REDACTED]");
    expect(result.redacted).toContain('+api_key="[REDACTED]"');
    expect(result.redacted).toContain("export MODE=development");
    expect(result.redacted).not.toContain("AbCdEf0123456789");
  });

  it("preserves ordinary diff and prompt text", () => {
    const input = "diff --git a/src/app.ts b/src/app.ts\n+export const answer = 42;";
    expect(redactSecrets(input)).toEqual({ redacted: input, hits: [] });
  });

  it("formats warning metadata without exposing matched values", () => {
    const warning = formatSecretRedactionWarning("diff.patch", [
      { kind: "openai_token", count: 2 },
    ]);
    expect(warning).toContain("redacted 2 potential secret(s)");
    expect(warning).toContain("openai_token:2");
  });
});
