// GeneralStaff — Ollama provider adapter (gs-151, Phase 2)
//
// Wraps a local Ollama server behind the LLMProvider interface defined
// in ./types. Intended for digest-tier routes (digest / cycle_summary /
// classifier) — the reviewer path has its own inline dispatcher in
// src/reviewer.ts and is NOT a consumer of this module.
//
// Unlike the reviewer invoker, this adapter does NOT emit the
// `[REVIEWER ERROR]` sentinel. Digest callers expect the neutral
// ProviderInvokeResult shape ({ content, error? }).

import type {
  LLMProvider,
  ProviderDescriptor,
  ProviderHealth,
  ProviderInvokeOptions,
  ProviderInvokeResult,
} from "./types";

const DEFAULT_HOST = "http://localhost:11434";
const DEFAULT_MAX_TOKENS = 800;
const DEFAULT_TEMPERATURE = 0;

export function createOllamaProvider(descriptor: ProviderDescriptor): LLMProvider {
  if (descriptor.kind !== "ollama") {
    throw new Error(
      `createOllamaProvider expected kind='ollama', got '${descriptor.kind}'`,
    );
  }
  const host = (descriptor.host ?? DEFAULT_HOST).replace(/\/$/, "");
  const model = descriptor.model;

  return {
    name: descriptor.id,

    async invoke(
      prompt: string,
      opts?: ProviderInvokeOptions,
    ): Promise<ProviderInvokeResult> {
      const temperature = opts?.temperature ?? DEFAULT_TEMPERATURE;
      const numPredict = opts?.maxTokens ?? DEFAULT_MAX_TOKENS;

      try {
        const response = await fetch(`${host}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            stream: false,
            options: {
              temperature,
              num_predict: numPredict,
            },
          }),
        });
        if (!response.ok) {
          const body = await response.text();
          return {
            content: "",
            error: `Ollama ${response.status} ${response.statusText}: ${body.slice(0, 1500)}`,
          };
        }
        const data = (await response.json()) as {
          message?: { content?: string };
          done_reason?: string;
        };
        const content = data?.message?.content;
        if (typeof content !== "string" || content.length === 0) {
          const hint =
            data?.done_reason === "length"
              ? " (response truncated — consider raising maxTokens)"
              : "";
          return {
            content: "",
            error: `Ollama response missing content${hint}`,
          };
        }
        return { content };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: "",
          error: `Ollama fetch failed (is the Ollama server running at ${host}?): ${msg}`,
        };
      }
    },

    async health(): Promise<ProviderHealth> {
      const start = Date.now();
      try {
        const response = await fetch(`${host}/api/tags`, { method: "GET" });
        const latencyMs = Date.now() - start;
        if (!response.ok) {
          return {
            reachable: false,
            host,
            latencyMs,
            error: `HTTP ${response.status} ${response.statusText}`,
          };
        }
        return { reachable: true, host, latencyMs };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { reachable: false, host, error: msg };
      }
    },
  };
}
