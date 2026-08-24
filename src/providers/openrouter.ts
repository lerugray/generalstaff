// GeneralStaff — OpenRouter provider adapter
//
// Fills the hook provider_config.yaml.example has always described and the
// Phase 2 registry refused: `kind: openrouter`. Same LLMProvider contract as
// ./ollama, same neutral ProviderInvokeResult shape — no `[REVIEWER ERROR]`
// sentinel, because reviewer dispatch still lives inline in src/reviewer.ts.
//
// Why it is worth having next to Ollama: OpenRouter carries free-tier models
// far larger than anything that fits on the box, which makes a second, cheap
// opinion practical on every digest and classification rather than only when
// the local model is running.
//
// The key is never taken as a literal in provider_config.yaml — that file is
// not gitignored. It is read ONLY from the environment variable named by
// `api_key_env` (default OPENROUTER_API_KEY). Deliberately no ~/.config
// fallback: this is a BYOK tool other people install, and a key picked up from
// somewhere the config never mentions is both surprising and untestable.

import type {
  LLMProvider,
  ProviderDescriptor,
  ProviderHealth,
  ProviderInvokeOptions,
  ProviderInvokeResult,
} from "./types";

const DEFAULT_HOST = "https://openrouter.ai/api/v1";
const DEFAULT_MAX_TOKENS = 800;
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_KEY_ENV = "OPENROUTER_API_KEY";

export function resolveApiKey(descriptor: ProviderDescriptor): string | null {
  const fromEnv = process.env[descriptor.api_key_env ?? DEFAULT_KEY_ENV];
  return fromEnv && fromEnv.trim().length > 0 ? fromEnv.trim() : null;
}

export function createOpenRouterProvider(
  descriptor: ProviderDescriptor,
): LLMProvider {
  if (descriptor.kind !== "openrouter") {
    throw new Error(
      `createOpenRouterProvider expected kind='openrouter', got '${descriptor.kind}'`,
    );
  }
  const host = (descriptor.host ?? DEFAULT_HOST).replace(/\/$/, "");
  const model = descriptor.model;
  const keyEnv = descriptor.api_key_env ?? DEFAULT_KEY_ENV;

  return {
    name: descriptor.id,

    async invoke(
      prompt: string,
      opts?: ProviderInvokeOptions,
    ): Promise<ProviderInvokeResult> {
      const apiKey = resolveApiKey(descriptor);
      if (!apiKey) {
        return {
          content: "",
          error: `OpenRouter API key not found — set $${keyEnv}`,
        };
      }

      const controller = new AbortController();
      const timer = opts?.timeoutMs
        ? setTimeout(() => controller.abort(), opts.timeoutMs)
        : undefined;

      try {
        const response = await fetch(`${host}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            stream: false,
            temperature: opts?.temperature ?? DEFAULT_TEMPERATURE,
            max_tokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const body = await response.text();
          return {
            content: "",
            error: `OpenRouter ${response.status} ${response.statusText}: ${body.slice(0, 1500)}`,
          };
        }
        const data = (await response.json()) as {
          error?: { message?: string };
          choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        };
        // OpenRouter reports upstream provider failures as a 200 with an
        // `error` member, so a status check alone is not enough.
        if (data?.error) {
          return {
            content: "",
            error: `OpenRouter upstream error: ${String(data.error.message ?? "unknown").slice(0, 1500)}`,
          };
        }
        const choice = data?.choices?.[0];
        const content = choice?.message?.content;
        if (typeof content !== "string" || content.length === 0) {
          const hint =
            choice?.finish_reason === "length"
              ? " (response truncated — consider raising maxTokens)"
              : "";
          return { content: "", error: `OpenRouter response missing content${hint}` };
        }
        return { content };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const aborted = err instanceof Error && err.name === "AbortError";
        return {
          content: "",
          error: aborted
            ? `OpenRouter request timed out after ${opts?.timeoutMs}ms`
            : `OpenRouter fetch failed: ${msg}`,
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },

    async health(): Promise<ProviderHealth> {
      const apiKey = resolveApiKey(descriptor);
      if (!apiKey) {
        return {
          reachable: false,
          host,
          error: `no API key — set $${keyEnv}`,
        };
      }
      const start = Date.now();
      try {
        // /key both proves the endpoint is up and that this key is live,
        // which /models would not.
        const response = await fetch(`${host}/key`, {
          method: "GET",
          headers: { Authorization: `Bearer ${apiKey}` },
        });
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
