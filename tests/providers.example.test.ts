import { describe, expect, it } from "bun:test";
import { join } from "path";
import {
  getProviderForRole,
  hasProviderForRole,
  loadProviderRegistry,
} from "../src/providers/registry";

// gs-153: pin provider_config.yaml.example to the registry loader so
// the example doesn't rot away from the code that actually reads it.

const EXAMPLE_PATH = join(
  import.meta.dir,
  "..",
  "provider_config.yaml.example",
);

describe("provider_config.yaml.example (gs-153)", () => {
  it("parses without error via loadProviderRegistry", async () => {
    const registry = await loadProviderRegistry(EXAMPLE_PATH);
    expect(registry.providers.size).toBeGreaterThan(0);
  });

  it("declares the ollama_llama3 provider the task spec calls for", async () => {
    const registry = await loadProviderRegistry(EXAMPLE_PATH);
    const descriptor = registry.providers.get("ollama_llama3");
    expect(descriptor).toBeDefined();
    expect(descriptor?.kind).toBe("ollama");
    expect(descriptor?.model).toBe("llama3:8b");
    expect(descriptor?.host).toBe("http://localhost:11434");
  });

  it("routes digest / cycle_summary / classifier to ollama_llama3", async () => {
    const registry = await loadProviderRegistry(EXAMPLE_PATH);
    expect(registry.routes.digest).toBe("ollama_llama3");
    expect(registry.routes.cycle_summary).toBe("ollama_llama3");
    expect(registry.routes.classifier).toBe("ollama_llama3");
  });

  it("hasProviderForRole resolves true for every routed role", async () => {
    const registry = await loadProviderRegistry(EXAMPLE_PATH);
    expect(hasProviderForRole(registry, "digest")).toBe(true);
    expect(hasProviderForRole(registry, "cycle_summary")).toBe(true);
    expect(hasProviderForRole(registry, "classifier")).toBe(true);
  });

  it("getProviderForRole instantiates an ollama LLMProvider for each role", async () => {
    const registry = await loadProviderRegistry(EXAMPLE_PATH);
    for (const role of ["digest", "cycle_summary", "classifier"] as const) {
      const provider = getProviderForRole(registry, role);
      expect(provider.name).toBe("ollama_llama3");
      expect(typeof provider.invoke).toBe("function");
    }
  });
});
