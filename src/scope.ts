// GeneralStaff — autonomous-mode SURVEY + SCOPE (gs-332, 2026-06-22, v0.8.0)
//
// The autonomous task-generation step GS lacks. For a project with
// `autonomous.enabled`, SURVEY builds a compact state digest from REAL project
// state (MISSION + git log + already-queued tasks) and SCOPE asks an off-cap
// model to propose concrete next work items. The proposals then go through the
// GATE+CLASSIFY pass (judgment_gate) before anything is ledgered or dispatched.
//
// Faithful TS port of wintermute/fleet_loop.py's `survey` + `scope` +
// `parse_scoped_by_proj`. The OpenRouter call mirrors judgment_gate.ts's
// invokeGate (same URL/headers/AbortController, BYOK via OPENROUTER_API_KEY).
//
// Design constraints (mirror judgment_gate.ts):
//   - survey() never throws on a missing/malformed state file — a messy
//     tasks.json must not crash the run (it degrades to "no queued tasks").
//   - scope() is the only network surface; it throws on failure and the
//     caller (autonomous_session) catches → logs → skips that project.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { projectStateDir } from "./state";
import type { ProjectConfig, DispatcherConfig, ScopedItem } from "./types";

// The real OpenRouter model id the judgment gate already uses (the human
// routing-label "openrouter/qwen3.6-plus" maps to this API string). Override
// per-project via autonomous.scoper_model or fleet-wide via the dispatcher.
export const DEFAULT_SCOPER_MODEL = "qwen/qwen3.6-plus";
export const DEFAULT_SCOPE_COUNT = 3;
// Wide history window: a narrow window misses older shipped work and the
// scoper re-proposes it. Tunable via GENERALSTAFF_SCOPE_LOG_WINDOW.
const DEFAULT_LOG_WINDOW = 200;
// Generous: the scoper is a reasoning model (qwen3.6-plus) chewing a ~4-5k-char
// survey prompt — measured ~55s, which overruns a 60s budget under any
// variance. 150s leaves real headroom. Tunable via the caller's timeoutMs.
const DEFAULT_TIMEOUT_MS = 150_000;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// qwen3.x reasoning models can wrap a <think>...</think> block; strip it so
// the numbered list parses cleanly.
function stripThink(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/** Build a compact state digest from real project state — MISSION (purpose),
 *  the git commit history (already-SHIPPED work the scoper must not re-propose),
 *  and already-queued task titles. Read-only; resilient to missing/malformed
 *  files. Faithful port of wintermute's `survey`. */
export function survey(
  project: ProjectConfig,
  config?: DispatcherConfig,
  opts: { logWindow?: number } = {},
): string {
  const stateDir = projectStateDir(project.id, config);
  const parts: string[] = [`### PROJECT: ${project.id}`];

  // MISSION (purpose) — first 22 lines, like wintermute.
  const missionPath = join(stateDir, "MISSION.md");
  if (existsSync(missionPath)) {
    try {
      const head = readFileSync(missionPath, "utf-8")
        .split(/\r?\n/)
        .slice(0, 22)
        .join("\n");
      parts.push("## MISSION (purpose):\n" + head);
    } catch {
      /* unreadable MISSION — skip, never crash the survey */
    }
  }

  // SHIPPED — commit history across all branches. Already implemented; the
  // scoper must not propose anything these cover, even partially.
  const win =
    opts.logWindow ??
    (Number(process.env.GENERALSTAFF_SCOPE_LOG_WINDOW) || DEFAULT_LOG_WINDOW);
  const log = spawnSync(
    "git",
    ["-C", project.path, "log", "--oneline", "--all", `-${win}`],
    { encoding: "utf-8", timeout: 30_000 },
  );
  const history = (log.stdout ?? "").trim();
  parts.push(
    `## SHIPPED -- commit history, last ${win} commits across all branches ` +
      "(already IMPLEMENTED; do NOT propose anything these already cover, even partially):\n" +
      history,
  );

  // ALREADY-QUEUED TASKS — title/subject strings, first 25. Regex-scraped
  // (not the strict loader) so a malformed tasks.json degrades gracefully.
  const tasksPath = join(stateDir, "tasks.json");
  if (existsSync(tasksPath)) {
    try {
      const raw = readFileSync(tasksPath, "utf-8");
      const titles: string[] = [];
      const re = /"(?:title|subject)"\s*:\s*"([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(raw)) !== null && titles.length < 25) {
        titles.push(m[1]);
      }
      if (titles.length > 0) {
        parts.push(
          "## ALREADY-QUEUED TASKS (do not re-propose):\n" +
            titles.map((t) => `- ${t}`).join("\n"),
        );
      }
    } catch {
      /* unreadable tasks.json — skip */
    }
  }

  return parts.join("\n\n");
}

/** The SCOPE prompt — asks for EXACTLY `count` concrete next work items, each
 *  tagged [MECHANICAL] or [DESIGN], with no repeats of shipped/queued work.
 *  Faithful port of wintermute's `scope` prompt, parameterized on count. */
export function buildScopePrompt(digest: string, count: number): string {
  return (
    "You are scoping work for a software/creative project. Based on the state below " +
    "(mission, recent commits, already-queued tasks), propose EXACTLY " +
    `${count} concrete, specific ` +
    "work items it plausibly needs NEXT. Do NOT repeat anything already queued, and do NOT " +
    "propose anything the SHIPPED commits show is already built. For each: " +
    "(a) a one-line title, (b) one sentence why it is load-bearing, (c) a tag [MECHANICAL] " +
    "(bounded, no taste/design judgment) or [DESIGN] (needs a taste/feel/scope/revenue call). " +
    "Numbered list only, no preamble.\n\nPROJECT STATE:\n" +
    digest
  );
}

/** Parse the scoper's numbered-list response into structured items. Strips a
 *  leading <think> block, the markdown bold/numbering, and the trailing
 *  [MECHANICAL]/[DESIGN] tag (captured as `tag`). Faithful port of
 *  wintermute's `parse_scoped_by_proj` per-project logic. */
export function parseScopedItems(text: string, max?: number): ScopedItem[] {
  const clean = stripThink(text);
  const items: ScopedItem[] = [];
  const re = /^\s*\d+\.\s*\**(.+?)\**\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const rawLine = m[1];
    const tagMatch = rawLine.match(/\[(MECHANICAL|DESIGN)\]/i);
    const tag = tagMatch
      ? tagMatch[1].toUpperCase() === "MECHANICAL"
        ? "mechanical"
        : "design"
      : null;
    const title = rawLine
      .replace(/\[(MECHANICAL|DESIGN)\]/gi, "")
      .replace(/^[\s\-—*]+|[\s\-—*]+$/g, "")
      // Strip a leading "(a)" / "a)" / "(1)" enumerator: scopers told to give
      // "(a) a one-line title, (b) why…" sometimes echo the (a) into the title.
      .replace(/^\(?[a-z0-9]\)\s*/i, "")
      .trim();
    if (title) items.push({ title, tag });
    if (max !== undefined && items.length >= max) break;
  }
  return items;
}

// --- Code-grounding for the GATE (gs-334, 2026-06-22) ---
// survey() feeds the scoper only commit MESSAGES + task TITLES, never the code,
// so it re-proposed already-SHIPPED work (a subscription page that lives inside
// index.html+app.js; hands_off guards inside smoke-test.js — both invisible to a
// commit log AND to a bare file list). Fix: before the GATE classifies an item,
// grep the working tree for the item's key terms and hand the gate that evidence
// so it can REJECT what the code already provides. A file list misses in-file
// features; grep does not.

const PROBE_STOP = new Set([
  "the", "and", "for", "with", "into", "that", "this", "its", "are", "add",
  "adds", "new", "page", "route", "button", "panel", "view", "show", "support",
  "supports", "enable", "enables", "build", "builds", "create", "creates",
  "wire", "wires", "implement", "implements", "feature", "across", "each",
  "via", "from", "using", "use", "make", "ensure", "ensures", "structural",
  "guard", "guards", "assert", "asserts", "test", "tests", "smoke", "file",
  "files", "code", "counter", "indicator", "setup", "pending",
]);

/** Derive a small set of distinctive grep probes from a scoped item's title:
 *  quoted strings + code-ish identifiers (snake_case / camelCase / CONSTANT_CASE
 *  / dotted filenames) first (strongest signal), then distinctive content words.
 *  Pure + deterministic. */
export function deriveProbeTerms(title: string, max = 8): string[] {
  const probes: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    const v = t.trim();
    const k = v.toLowerCase();
    if (v.length >= 3 && v.length <= 40 && !seen.has(k)) {
      seen.add(k);
      probes.push(v);
    }
  };
  // Quoted strings — exact, strong.
  for (const m of title.matchAll(/["'`]([^"'`]{3,40})["'`]/g)) push(m[1]);
  // Identifiers with an internal separator (snake / kebab / dotted path / file).
  for (const m of title.matchAll(
    /\b([A-Za-z][A-Za-z0-9]*(?:[_./-][A-Za-z0-9]+)+)\b/g,
  ))
    push(m[1]);
  // camelCase and CONSTANT_CASE.
  for (const m of title.matchAll(/\b([a-z]+[A-Z][A-Za-z0-9]*)\b/g)) push(m[1]);
  for (const m of title.matchAll(/\b([A-Z]{2,}(?:_[A-Z0-9]+)*)\b/g)) push(m[1]);
  // Distinctive content words (>=4 chars, not generic dev vocabulary).
  for (const w of title.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []) {
    if (!PROBE_STOP.has(w)) push(w);
  }
  return probes.slice(0, max);
}

// Restrict grounding greps to SOURCE files. Prose/docs (*.md, planning notes,
// READMEs) mention a feature's words whether or not it's built — and a doc that
// *plans* a feature is the opposite signal from code that *implements* it. Only
// real code/markup/config carries "is it implemented" signal. (git grep already
// searches only tracked files, so gitignored build dirs never appear.)
const SOURCE_GLOBS = [
  "*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs", "*.py", "*.rs", "*.go",
  "*.rb", "*.java", "*.kt", "*.swift", "*.c", "*.h", "*.cpp", "*.hpp", "*.cc",
  "*.cs", "*.gd", "*.vue", "*.svelte", "*.php", "*.lua", "*.html", "*.css",
  "*.scss", "*.sql", "*.toml", "*.yaml", "*.yml",
  ":(exclude)*-lock.json", ":(exclude)*.min.js", ":(exclude)*.min.css",
];

export interface GroundedItemEvidence {
  title: string;
  probes: string[];
  /** Per-probe, the tracked SOURCE files that contain it (capped). */
  hits: Array<{ term: string; files: string[] }>;
}

/** For each scoped item, grep the repo's TRACKED files for its probe terms and
 *  collect which files match. Read-only (git grep). Never throws — a failed grep
 *  yields no hits for that term (degrades to "no evidence", never crashes the
 *  run). */
export function groundScopedItems(
  repoPath: string,
  items: ScopedItem[],
  opts: { maxFilesPerTerm?: number } = {},
): GroundedItemEvidence[] {
  const maxFiles = opts.maxFilesPerTerm ?? 6;
  return items.map((it) => {
    const probes = deriveProbeTerms(it.title);
    const hits: Array<{ term: string; files: string[] }> = [];
    for (const term of probes) {
      const r = spawnSync(
        "git",
        ["-C", repoPath, "grep", "-ilF", "-e", term, "--", ...SOURCE_GLOBS],
        { encoding: "utf-8", timeout: 10_000 },
      );
      const files = (r.stdout ?? "")
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(0, maxFiles);
      if (files.length > 0) hits.push({ term, files });
    }
    return { title: it.title, probes, hits };
  });
}

/** Render grounding evidence as a compact, numbered block for the GATE prompt
 *  (numbers align with the scoper's numbered item list). Pure. */
export function renderCodeEvidence(ev: GroundedItemEvidence[]): string {
  return ev
    .map((e, i) => {
      if (e.hits.length === 0) {
        return (
          `${i + 1}. ${e.title}\n` +
          `   (no code matches for: ${e.probes.join(", ") || "n/a"} → likely NOT built yet)`
        );
      }
      const lines = e.hits.map(
        (h) =>
          `   - "${h.term}" → ${h.files.length} file(s): ${h.files.join(", ")}`,
      );
      return `${i + 1}. ${e.title}\n${lines.join("\n")}`;
    })
    .join("\n");
}

/** POST the scope prompt to OpenRouter, AbortController-bounded. Returns the
 *  raw model text (parse with parseScopedItems). Throws on any failure — the
 *  caller catches and skips the project. Mirrors judgment_gate.ts's invokeGate. */
export async function scope(
  digest: string,
  model: string,
  apiKey: string,
  opts: { count?: number; timeoutMs?: number } = {},
): Promise<string> {
  const count = opts.count ?? DEFAULT_SCOPE_COUNT;
  const prompt = buildScopePrompt(digest, count);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.4,
        max_tokens: 1500,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `OpenRouter ${response.status} ${response.statusText}: ${body.slice(0, 800)}`,
      );
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error(
        `OpenRouter response missing content: ${JSON.stringify(data).slice(0, 800)}`,
      );
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}
