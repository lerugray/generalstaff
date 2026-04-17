// GeneralStaff — provider registry loader (gs-152, Phase 2)
//
// Loads provider_config.yaml and exposes a typed registry of providers
// plus role routes for digest / cycle_summary / classifier callers. The
// reviewer path is NOT a consumer of this module — reviewer dispatch
// remains inline in src/reviewer.ts per Phase 2 scoping.
//
// When provider_config.yaml is missing OR exists but is empty / all
// whitespace, the registry contains no providers and every route points
// at the string "noop"; callers should consult hasProviderForRole()
// before dispatching. Any other malformed input surfaces as
// ProviderConfigError so the caller sees a single error type.

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { getRootDir } from "../state";
import { createOllamaProvider } from "./ollama";
import type {
  LLMProvider,
  ProviderDescriptor,
  ProviderKind,
  ProviderRole,
} from "./types";

const NOOP_PROVIDER_ID = "noop";
const ALLOWED_KINDS: readonly ProviderKind[] = ["ollama", "openrouter", "claude"];
const ALLOWED_ROLES: readonly ProviderRole[] = [
  "digest",
  "cycle_summary",
  "classifier",
];

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

export interface ProviderRegistry {
  providers: Map<string, ProviderDescriptor>;
  routes: Record<ProviderRole, string>;
}

function emptyRoutes(): Record<ProviderRole, string> {
  return {
    digest: NOOP_PROVIDER_ID,
    cycle_summary: NOOP_PROVIDER_ID,
    classifier: NOOP_PROVIDER_ID,
  };
}

function emptyRegistry(): ProviderRegistry {
  return { providers: new Map(), routes: emptyRoutes() };
}

function validateDescriptor(raw: unknown, index: number): ProviderDescriptor {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ProviderConfigError(
      `provider_config.yaml: providers[${index}] must be an object`,
    );
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length === 0) {
    throw new ProviderConfigError(
      `provider_config.yaml: providers[${index}].id must be a non-empty string (got ${JSON.stringify(r.id)})`,
    );
  }
  if (
    typeof r.kind !== "string" ||
    !ALLOWED_KINDS.includes(r.kind as ProviderKind)
  ) {
    throw new ProviderConfigError(
      `provider_config.yaml: providers[${index}].kind must be one of ${ALLOWED_KINDS.join(", ")} (got ${JSON.stringify(r.kind)})`,
    );
  }
  if (typeof r.model !== "string" || r.model.length === 0) {
    throw new ProviderConfigError(
      `provider_config.yaml: providers[${index}].model must be a non-empty string (got ${JSON.stringify(r.model)})`,
    );
  }
  if (r.host !== undefined && typeof r.host !== "string") {
    throw new ProviderConfigError(
      `provider_config.yaml: providers[${index}].host must be a string when present (got ${JSON.stringify(r.host)})`,
    );
  }
  if (r.api_key_env !== undefined && typeof r.api_key_env !== "string") {
    throw new ProviderConfigError(
      `provider_config.yaml: providers[${index}].api_key_env must be a string when present (got ${JSON.stringify(r.api_key_env)})`,
    );
  }
  const descriptor: ProviderDescriptor = {
    id: r.id,
    kind: r.kind as ProviderKind,
    model: r.model,
  };
  if (r.host !== undefined) descriptor.host = r.host as string;
  if (r.api_key_env !== undefined) {
    descriptor.api_key_env = r.api_key_env as string;
  }
  return descriptor;
}

function validateRoutes(
  raw: unknown,
  providers: Map<string, ProviderDescriptor>,
): Record<ProviderRole, string> {
  const routes = emptyRoutes();
  if (raw === undefined || raw === null) return routes;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ProviderConfigError(
      "provider_config.yaml: routes must be an object",
    );
  }
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    if (!ALLOWED_ROLES.includes(key as ProviderRole)) {
      throw new ProviderConfigError(
        `provider_config.yaml: routes contains unknown role '${key}' (allowed: ${ALLOWED_ROLES.join(", ")})`,
      );
    }
    const value = r[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new ProviderConfigError(
        `provider_config.yaml: routes.${key} must be a non-empty string (got ${JSON.stringify(value)})`,
      );
    }
    if (!providers.has(value)) {
      throw new ProviderConfigError(
        `provider_config.yaml: routes.${key} references unknown provider '${value}'`,
      );
    }
    routes[key as ProviderRole] = value;
  }
  return routes;
}

export async function loadProviderRegistry(
  configPath?: string,
): Promise<ProviderRegistry> {
  const filePath =
    configPath ?? join(getRootDir(), "provider_config.yaml");
  if (!existsSync(filePath)) {
    return emptyRegistry();
  }
  const raw = await readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ProviderConfigError(
      `provider_config.yaml: YAML parse error — ${msg}`,
    );
  }
  if (parsed === null || parsed === undefined) {
    return emptyRegistry();
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProviderConfigError(
      "provider_config.yaml: root must be an object",
    );
  }
  const parsedObj = parsed as Record<string, unknown>;
  const rawProviders = parsedObj.providers;
  if (!Array.isArray(rawProviders)) {
    throw new ProviderConfigError(
      "provider_config.yaml: 'providers' must be an array",
    );
  }
  const providers = new Map<string, ProviderDescriptor>();
  rawProviders.forEach((entry, i) => {
    const descriptor = validateDescriptor(entry, i);
    if (providers.has(descriptor.id)) {
      throw new ProviderConfigError(
        `provider_config.yaml: duplicate provider id '${descriptor.id}'`,
      );
    }
    providers.set(descriptor.id, descriptor);
  });
  const routes = validateRoutes(parsedObj.routes, providers);
  return { providers, routes };
}

export function hasProviderForRole(
  registry: ProviderRegistry,
  role: ProviderRole,
): boolean {
  const id = registry.routes[role];
  return id !== NOOP_PROVIDER_ID && registry.providers.has(id);
}

export function getProviderForRole(
  registry: ProviderRegistry,
  role: ProviderRole,
): LLMProvider {
  const id = registry.routes[role];
  if (id === NOOP_PROVIDER_ID) {
    throw new ProviderConfigError(
      `No provider routed for role '${role}' (routes.${role} is unset). Call hasProviderForRole() first.`,
    );
  }
  return instantiateProvider(registry, id);
}

export function getProviderById(
  registry: ProviderRegistry,
  id: string,
): LLMProvider {
  if (!registry.providers.has(id)) {
    throw new ProviderConfigError(
      `Unknown provider id '${id}'`,
    );
  }
  return instantiateProvider(registry, id);
}

function instantiateProvider(
  registry: ProviderRegistry,
  id: string,
): LLMProvider {
  const descriptor = registry.providers.get(id);
  if (!descriptor) {
    throw new ProviderConfigError(
      `Unknown provider id '${id}'`,
    );
  }
  switch (descriptor.kind) {
    case "ollama":
      return createOllamaProvider(descriptor);
    case "openrouter":
    case "claude":
      throw new ProviderConfigError(
        `Provider kind '${descriptor.kind}' not implemented in Phase 2 — see src/reviewer.ts for inline dispatch`,
      );
    default:
      throw new ProviderConfigError(
        `Unknown provider kind '${String(descriptor.kind)}'`,
      );
  }
}
