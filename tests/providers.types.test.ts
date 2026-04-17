import { describe, expect, it } from "bun:test";
import type {
  LLMProvider,
  ProviderDescriptor,
  ProviderHealth,
  ProviderInvokeOptions,
  ProviderInvokeResult,
  ProviderKind,
  ProviderRole,
} from "../src/providers/types";

describe("provider types (gs-150)", () => {
  it("imports the module without runtime error", async () => {
    const mod = await import("../src/providers/types");
    expect(mod).toBeDefined();
  });

  it("ProviderKind accepts the three declared kinds", () => {
    const kinds: ProviderKind[] = ["ollama", "openrouter", "claude"];
    expect(kinds).toHaveLength(3);
  });

  it("ProviderRole covers the Phase 2 roles (reviewer intentionally excluded)", () => {
    const roles: ProviderRole[] = ["digest", "cycle_summary", "classifier"];
    expect(roles).toHaveLength(3);
    // reviewer is NOT a ProviderRole — reviewer dispatch stays in src/reviewer.ts
    // @ts-expect-error reviewer is not a ProviderRole in Phase 2
    const bad: ProviderRole = "reviewer";
    void bad;
  });

  it("ProviderDescriptor shape accepts minimal and full entries", () => {
    const minimal: ProviderDescriptor = {
      id: "ollama_llama3",
      kind: "ollama",
      model: "llama3:8b",
    };
    const full: ProviderDescriptor = {
      id: "openrouter_qwen",
      kind: "openrouter",
      model: "qwen/qwen3-coder-plus",
      host: "https://openrouter.ai/api/v1",
      api_key_env: "OPENROUTER_API_KEY",
    };
    expect(minimal.id).toBe("ollama_llama3");
    expect(full.api_key_env).toBe("OPENROUTER_API_KEY");
  });

  it("ProviderInvokeOptions fields are all optional", () => {
    const empty: ProviderInvokeOptions = {};
    const full: ProviderInvokeOptions = {
      timeoutMs: 30000,
      maxTokens: 200,
      temperature: 0,
    };
    expect(empty).toEqual({});
    expect(full.maxTokens).toBe(200);
  });

  it("ProviderInvokeResult carries content and optional error", () => {
    const ok: ProviderInvokeResult = { content: "hello" };
    const bad: ProviderInvokeResult = { content: "", error: "timeout" };
    expect(ok.content).toBe("hello");
    expect(bad.error).toBe("timeout");
  });

  it("ProviderHealth shape", () => {
    const up: ProviderHealth = { reachable: true, latencyMs: 42 };
    const down: ProviderHealth = { reachable: false, error: "ECONNREFUSED" };
    expect(up.reachable).toBe(true);
    expect(down.error).toBe("ECONNREFUSED");
  });

  it("LLMProvider is implementable with a stub and satisfies the interface", async () => {
    const stub: LLMProvider = {
      name: "stub",
      async invoke(prompt: string, opts?: ProviderInvokeOptions) {
        return { content: `echo:${prompt}:${opts?.maxTokens ?? -1}` };
      },
      async health() {
        return { reachable: true, latencyMs: 1 };
      },
    };
    const result = await stub.invoke("hi", { maxTokens: 10 });
    expect(result.content).toBe("echo:hi:10");
    const h = await stub.health!();
    expect(h.reachable).toBe(true);
  });

  it("LLMProvider.health is optional", () => {
    const stub: LLMProvider = {
      name: "no-health",
      async invoke() {
        return { content: "" };
      },
    };
    expect(stub.health).toBeUndefined();
  });
});
