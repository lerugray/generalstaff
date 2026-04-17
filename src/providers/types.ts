// GeneralStaff — provider abstraction types (gs-150, Phase 2)
//
// Pure type definitions for the Phase 2 provider layer. These types
// describe digest / cycle_summary / classifier routing ONLY — reviewer
// dispatch remains inline in src/reviewer.ts per Phase 2 scoping.

export type ProviderKind = "ollama" | "openrouter" | "claude";

export type ProviderRole = "digest" | "cycle_summary" | "classifier";

export interface ProviderInvokeOptions {
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
}

export interface ProviderInvokeResult {
  content: string;
  error?: string;
}

export interface ProviderHealth {
  reachable: boolean;
  host?: string;
  error?: string;
  latencyMs?: number;
}

export interface LLMProvider {
  name: string;
  invoke(prompt: string, opts?: ProviderInvokeOptions): Promise<ProviderInvokeResult>;
  health?(): Promise<ProviderHealth>;
}

export interface ProviderDescriptor {
  id: string;
  kind: ProviderKind;
  model: string;
  host?: string;
  api_key_env?: string;
}
