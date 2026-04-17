import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  getProviderForRole,
  hasProviderForRole,
  loadProviderRegistry,
  ProviderConfigError,
} from "../src/providers/registry";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "gs-registry-"));
}

function writeCfg(dir: string, content: string): string {
  const path = join(dir, "provider_config.yaml");
  writeFileSync(path, content, "utf8");
  return path;
}

describe("loadProviderRegistry (gs-152)", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads a valid config with all three routes", async () => {
    const path = writeCfg(
      dir,
      `
providers:
  - id: ollama_llama3
    kind: ollama
    model: llama3:8b
    host: http://localhost:11434
  - id: ollama_qwen
    kind: ollama
    model: qwen3:8b
routes:
  digest: ollama_llama3
  cycle_summary: ollama_qwen
  classifier: ollama_llama3
`,
    );
    const registry = await loadProviderRegistry(path);
    expect(registry.providers.size).toBe(2);
    expect(registry.providers.get("ollama_llama3")?.model).toBe("llama3:8b");
    expect(registry.providers.get("ollama_llama3")?.host).toBe(
      "http://localhost:11434",
    );
    expect(registry.providers.get("ollama_qwen")?.host).toBeUndefined();
    expect(registry.routes.digest).toBe("ollama_llama3");
    expect(registry.routes.cycle_summary).toBe("ollama_qwen");
    expect(registry.routes.classifier).toBe("ollama_llama3");
  });

  it("returns an empty registry when the file is missing", async () => {
    const path = join(dir, "nonexistent.yaml");
    const registry = await loadProviderRegistry(path);
    expect(registry.providers.size).toBe(0);
    expect(registry.routes.digest).toBe("noop");
    expect(registry.routes.cycle_summary).toBe("noop");
    expect(registry.routes.classifier).toBe("noop");
  });

  it("routes omitted for a role default to 'noop'", async () => {
    const path = writeCfg(
      dir,
      `
providers:
  - id: ollama_llama3
    kind: ollama
    model: llama3:8b
routes:
  digest: ollama_llama3
`,
    );
    const registry = await loadProviderRegistry(path);
    expect(registry.routes.digest).toBe("ollama_llama3");
    expect(registry.routes.cycle_summary).toBe("noop");
    expect(registry.routes.classifier).toBe("noop");
  });

  it("accepts an empty routes block and defaults every role to 'noop'", async () => {
    const path = writeCfg(
      dir,
      `
providers:
  - id: ollama_llama3
    kind: ollama
    model: llama3:8b
routes: {}
`,
    );
    const registry = await loadProviderRegistry(path);
    expect(registry.routes.digest).toBe("noop");
    expect(registry.routes.cycle_summary).toBe("noop");
    expect(registry.routes.classifier).toBe("noop");
  });

  it("accepts a config with no routes key at all", async () => {
    const path = writeCfg(
      dir,
      `
providers:
  - id: ollama_llama3
    kind: ollama
    model: llama3:8b
`,
    );
    const registry = await loadProviderRegistry(path);
    expect(registry.providers.size).toBe(1);
    expect(registry.routes.digest).toBe("noop");
  });

  it("rejects missing provider id", async () => {
    const path = writeCfg(
      dir,
      `
providers:
  - kind: ollama
    model: llama3:8b
`,
    );
    await expect(loadProviderRegistry(path)).rejects.toThrow(
      ProviderConfigError,
    );
    await expect(loadProviderRegistry(path)).rejects.toThrow(/\.id/);
  });

  it("rejects missing provider kind", async () => {
    const path = writeCfg(
      dir,
      `
providers:
  - id: x
    model: llama3:8b
`,
    );
    await expect(loadProviderRegistry(path)).rejects.toThrow(
      ProviderConfigError,
    );
    await expect(loadProviderRegistry(path)).rejects.toThrow(/\.kind/);
  });

  it("rejects missing provider model", async () => {
    const path = writeCfg(
      dir,
      `
providers:
  - id: x
    kind: ollama
`,
    );
    await expect(loadProviderRegistry(path)).rejects.toThrow(
      ProviderConfigError,
    );
    await expect(loadProviderRegistry(path)).rejects.toThrow(/\.model/);
  });

  it("rejects unknown provider kind", async () => {
    const path = writeCfg(
      dir,
      `
providers:
  - id: x
    kind: gemini
    model: gemini-2.5
`,
    );
    await expect(loadProviderRegistry(path)).rejects.toThrow(
      ProviderConfigError,
    );
    await expect(loadProviderRegistry(path)).rejects.toThrow(/gemini/);
  });

  it("rejects non-string host when present", async () => {
    const path = writeCfg(
      dir,
      `
providers:
  - id: x
    kind: ollama
    model: llama3:8b
    host: 42
`,
    );
    await expect(loadProviderRegistry(path)).rejects.toThrow(
      ProviderConfigError,
    );
    await expect(loadProviderRegistry(path)).rejects.toThrow(/host/);
  });

  it("rejects route that references an unknown provider", async () => {
    const path = writeCfg(
      dir,
      `
providers:
  - id: ollama_llama3
    kind: ollama
    model: llama3:8b
routes:
  digest: missing_provider
`,
    );
    await expect(loadProviderRegistry(path)).rejects.toThrow(
      ProviderConfigError,
    );
    await expect(loadProviderRegistry(path)).rejects.toThrow(/missing_provider/);
  });

  it("rejects unknown role in routes", async () => {
    const path = writeCfg(
      dir,
      `
providers:
  - id: ollama_llama3
    kind: ollama
    model: llama3:8b
routes:
  reviewer: ollama_llama3
`,
    );
    await expect(loadProviderRegistry(path)).rejects.toThrow(
      ProviderConfigError,
    );
    await expect(loadProviderRegistry(path)).rejects.toThrow(/reviewer/);
  });

  it("rejects duplicate provider id", async () => {
    const path = writeCfg(
      dir,
      `
providers:
  - id: dup
    kind: ollama
    model: a
  - id: dup
    kind: ollama
    model: b
`,
    );
    await expect(loadProviderRegistry(path)).rejects.toThrow(
      ProviderConfigError,
    );
    await expect(loadProviderRegistry(path)).rejects.toThrow(/dup/);
  });

  it("rejects a config where 'providers' is not an array", async () => {
    const path = writeCfg(
      dir,
      `
providers:
  id: ollama_llama3
`,
    );
    await expect(loadProviderRegistry(path)).rejects.toThrow(
      ProviderConfigError,
    );
    await expect(loadProviderRegistry(path)).rejects.toThrow(/array/);
  });
});

describe("hasProviderForRole / getProviderForRole (gs-152)", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("hasProviderForRole is false for noop routes", async () => {
    const registry = await loadProviderRegistry(join(dir, "absent.yaml"));
    expect(hasProviderForRole(registry, "digest")).toBe(false);
    expect(hasProviderForRole(registry, "cycle_summary")).toBe(false);
    expect(hasProviderForRole(registry, "classifier")).toBe(false);
  });

  it("hasProviderForRole is true when a provider is routed", async () => {
    const path = writeCfg(
      dir,
      `
providers:
  - id: ollama_llama3
    kind: ollama
    model: llama3:8b
routes:
  digest: ollama_llama3
`,
    );
    const registry = await loadProviderRegistry(path);
    expect(hasProviderForRole(registry, "digest")).toBe(true);
    expect(hasProviderForRole(registry, "cycle_summary")).toBe(false);
  });

  it("getProviderForRole instantiates an ollama provider", async () => {
    const path = writeCfg(
      dir,
      `
providers:
  - id: ollama_llama3
    kind: ollama
    model: llama3:8b
routes:
  digest: ollama_llama3
`,
    );
    const registry = await loadProviderRegistry(path);
    const provider = getProviderForRole(registry, "digest");
    expect(provider.name).toBe("ollama_llama3");
    expect(typeof provider.invoke).toBe("function");
  });

  it("getProviderForRole throws for unrouted roles", async () => {
    const path = writeCfg(
      dir,
      `
providers:
  - id: ollama_llama3
    kind: ollama
    model: llama3:8b
routes:
  digest: ollama_llama3
`,
    );
    const registry = await loadProviderRegistry(path);
    expect(() => getProviderForRole(registry, "cycle_summary")).toThrow(
      ProviderConfigError,
    );
  });

  it("getProviderForRole throws 'not implemented in Phase 2' for openrouter", async () => {
    const path = writeCfg(
      dir,
      `
providers:
  - id: or_qwen
    kind: openrouter
    model: qwen/qwen3-coder-plus
    api_key_env: OPENROUTER_API_KEY
routes:
  digest: or_qwen
`,
    );
    const registry = await loadProviderRegistry(path);
    expect(() => getProviderForRole(registry, "digest")).toThrow(
      /not implemented in Phase 2/,
    );
  });

  it("getProviderForRole throws 'not implemented in Phase 2' for claude", async () => {
    const path = writeCfg(
      dir,
      `
providers:
  - id: claude_sonnet
    kind: claude
    model: claude-sonnet-4-6
routes:
  classifier: claude_sonnet
`,
    );
    const registry = await loadProviderRegistry(path);
    expect(() => getProviderForRole(registry, "classifier")).toThrow(
      /not implemented in Phase 2/,
    );
  });
});
