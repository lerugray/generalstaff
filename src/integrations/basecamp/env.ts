// Basecamp integration — .env read/write helpers.
//
// Read: parse KEY=VALUE lines (ignore comments, blank lines). Leave
// commented placeholders (e.g. `# BASECAMP_ACCESS_TOKEN=`) as-is so
// update-in-place can find-and-replace them when tokens arrive.
//
// Write: update-in-place by key. For keys that already exist
// (commented or uncommented), replace that single line. For keys that
// don't, append. Preserves all other lines and comments.
//
// Scope: Basecamp-specific for now. If a second OAuth integration
// lands later, graduate to a shared helper at src/integrations/env.ts.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

export type EnvMap = Record<string, string>;

export function readEnv(path: string): EnvMap {
  if (!existsSync(path)) return {};
  const env: EnvMap = {};
  const text = readFileSync(path, "utf-8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return env;
}

/**
 * Update-or-append env entries at `path`. Existing lines matching
 * either `KEY=` or `# KEY=` have their content replaced (one-liner
 * replacement). Missing keys are appended at the end.
 *
 * Creates the file if absent.
 */
export function updateEnv(path: string, updates: EnvMap): void {
  const lines = existsSync(path)
    ? readFileSync(path, "utf-8").split(/\r?\n/)
    : [];

  const remaining = new Map(Object.entries(updates));

  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? "").trim();
    for (const [key, value] of remaining) {
      if (
        trimmed.startsWith(`${key}=`) ||
        trimmed.startsWith(`# ${key}=`)
      ) {
        lines[i] = `${key}=${value}`;
        remaining.delete(key);
        break;
      }
    }
  }

  for (const [key, value] of remaining) {
    lines.push(`${key}=${value}`);
  }

  // Ensure single trailing newline.
  let out = lines.join("\n");
  if (!out.endsWith("\n")) out += "\n";
  writeFileSync(path, out, "utf-8");
}
