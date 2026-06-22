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
