// GeneralStaff — pre-cycle judgment gate (gs-330, 2026-06-16, v0.7.0)
//
// A lightweight, self-contained pre-execution gate. After the picker resolves
// the next task and before the engineer spends tokens, the canonical
// Hammerstein system-prompt judges whether the picked task is LOAD-BEARING
// toward its goal or STUPID-INDUSTRIOUS slop (effort that pattern-matches
// progress but doesn't advance it). Verdict KEEP / REJECT.
//
// This is GS eating its own dogfood: GeneralStaff *is* the Hammerstein
// framework applied to autonomous dev work, and this applies it to the bot's
// own task selection. The instrument was proved out in the `wintermute`
// experiment (the gate reliably separates load-bearing from slop on clear-cut
// cases; the boundary is genuinely contestable only on borderline items —
// hence flag-first, never a hard veto by default).
//
// Relationship to the other gates:
//   - advisor (src/advisor.ts, gs-327): broad pre-cycle audit via the EXTERNAL
//     Hammerstein `h` CLI (must be installed on PATH), free-text verdict. This
//     gate instead calls OpenRouter INLINE (no external binary — just
//     OPENROUTER_API_KEY, which the reviewer path already uses) for a focused
//     KEEP/REJECT slop screen — the "inline provider routing inside GS" the
//     advisor's own comments deferred to v2, narrowed to one judgment. Both
//     can be enabled; they run independently.
//   - reviewer (src/reviewer.ts): orthogonal. The reviewer is POST-execution
//     (is the *code* correct?); this gate is PRE-execution (is the *task* the
//     right shape?). Today the bot can spend a full cycle writing correct code
//     for a wrong-shaped task and the reviewer passes it — the gap this fills.
//
// Design constraints (mirror advisor.ts):
//   - Zero overhead when judgment_gate is "off" / unset (caller short-circuits).
//   - Graceful no-op: a missing OPENROUTER_API_KEY, a fetch failure, a timeout,
//     or a verdict that won't parse all yield verdict "error" and the cycle
//     PROCEEDS. The gate never blocks the bot on its own infrastructure
//     failing — only an explicit REJECT under `skip` mode skips a cycle.
//   - Latency-bounded by an AbortController timeout (default 60s).

import { readFile } from "fs/promises";
import { join } from "path";
import type {
  JudgmentGateMode,
  JudgmentVerdict,
  JudgmentVerdictKind,
  JudgmentClass,
  ScopedItem,
  ClassifiedItem,
} from "./types";

/** Whether a gate verdict should skip the cycle, given the configured mode.
 *  Only an explicit REJECT under `skip` mode blocks a cycle — KEEP, error,
 *  and every verdict under `flag` / `off` proceed. This is the single
 *  decision the cycle site consults, kept pure so it's exhaustively testable
 *  independent of the OpenRouter call. */
export function shouldGateSkipCycle(
  mode: JudgmentGateMode,
  verdict: JudgmentVerdictKind,
): boolean {
  return mode === "skip" && verdict === "reject";
}

// wintermute's validated gate model: capable, cheap (~$0.001/call), and keeps
// the gate off the Anthropic cap. Override via GENERALSTAFF_JUDGMENT_GATE_MODEL.
export const DEFAULT_GATE_MODEL = "qwen/qwen3.6-plus";
const DEFAULT_TIMEOUT_MS = 60_000;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// The vendored prompt carries a documentation preamble that *mentions* the
// marker strings in prose; anchor extraction to the real heading lines
// (`^## === BEGIN/END SYSTEM PROMPT ===`) so those prose mentions are skipped.
const BEGIN_MARKER = /^## === BEGIN SYSTEM PROMPT ===\s*$/m;
const END_MARKER = /^## === END SYSTEM PROMPT ===\s*$/m;

let cachedPrompt: { path: string; text: string } | null = null;

function defaultPromptPath(): string {
  // Bundled asset next to this module: src/prompts/hammerstein_gate.md.
  return join(import.meta.dir, "prompts", "hammerstein_gate.md");
}

/** Load + cache the Hammerstein system-prompt, extracted from the vendored
 *  markdown between the BEGIN/END markers. Throws if the file is missing or
 *  the markers can't be found (caller converts to a graceful "error" verdict). */
export async function loadGatePrompt(promptPath?: string): Promise<string> {
  const path =
    promptPath ??
    process.env.GENERALSTAFF_JUDGMENT_GATE_PROMPT ??
    defaultPromptPath();
  if (cachedPrompt && cachedPrompt.path === path) return cachedPrompt.text;

  const raw = await readFile(path, "utf8");
  const begin = raw.match(BEGIN_MARKER);
  const end = raw.match(END_MARKER);
  if (
    !begin ||
    !end ||
    begin.index === undefined ||
    end.index === undefined ||
    end.index <= begin.index
  ) {
    throw new Error(
      `gate prompt ${path} missing BEGIN/END SYSTEM PROMPT markers`,
    );
  }
  const text = raw
    .slice(begin.index + begin[0].length, end.index)
    .trim();
  if (text.length === 0) {
    throw new Error(`gate prompt ${path} is empty between markers`);
  }
  cachedPrompt = { path, text };
  return text;
}

/** Test seam: drop the cached prompt so a later load re-reads from disk. */
export function _resetGatePromptCacheForTests(): void {
  cachedPrompt = null;
}

/** The terminal goal the picked task is judged against. */
export function buildGateGoal(project: { id: string; notes?: string }): string {
  const base = `Make real, load-bearing progress on the software project "${project.id}".`;
  const intent = project.notes?.trim();
  return intent ? `${base} Project intent: ${intent}` : base;
}

/** The user-turn framing (faithful port of wintermute's judge.py). */
export function buildGateUserPrompt(goal: string, action: string): string {
  return (
    `A goal-directed process (the GeneralStaff autonomous engineer) is pursuing this TERMINAL GOAL:\n\n${goal}\n\n` +
    `It has selected this CANDIDATE TASK and is about to spend a full engineering cycle on it:\n\n"${action}"\n\n` +
    `You are the gate between 'selected' and 'worked'. Judge ONLY this candidate task: is it ` +
    `load-bearing toward the terminal goal, or stupid-industrious slop dressed as progress ` +
    `(effort that pattern-matches the goal but does not advance it)?\n\n` +
    `Answer in exactly this format:\n` +
    `VERDICT: KEEP or REJECT\n` +
    `QUADRANT: <the quadrant this task operates in>\n` +
    `WHY: <one or two sentences>`
  );
}

// qwen3.x reasoning models can wrap a <think>...</think> block before the
// final answer; strip it so the VERDICT line parses cleanly.
function stripThink(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/** Parse the gate's free-text response into a structured verdict. Unparseable
 *  → verdict "error" (caller proceeds — error never blocks a cycle). */
export function parseGateVerdict(raw: string): {
  verdict: JudgmentVerdictKind;
  quadrant?: string;
  class?: JudgmentClass;
  reason: string;
} {
  const text = stripThink(raw);
  // [\s*]* after each label absorbs any mix of whitespace and markdown
  // asterisks on either side of the value (e.g. `**VERDICT:** **REJECT**`).
  const vMatch = text.match(/VERDICT:[\s*]*(KEEP|REJECT)\b/i);
  const verdict: JudgmentVerdictKind = !vMatch
    ? "error"
    : vMatch[1].toUpperCase() === "REJECT"
      ? "reject"
      : "keep";

  const qMatch = text.match(/QUADRANT:[\s*]*(.+?)[\s*]*$/im);
  const quadrant = qMatch?.[1]?.trim() || undefined;

  // gs-332: CLASS is only present in autonomous classify mode (BOT-SAFE /
  // DESIGN-FORK). Absent in the v0.7.0 single-task slop screen → undefined.
  const cls = parseGateClass(text);

  // WHY: capture to the next blank line or end of text.
  const wMatch = text.match(/WHY:[\s*]*([\s\S]+?)(?:\n\s*\n|$)/i);
  let reason = wMatch?.[1]?.replace(/[\s*]+$/, "").trim() ?? "";
  if (!reason) {
    // Fall back to the first non-empty line that isn't a label line.
    reason =
      text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l && !/^(VERDICT|QUADRANT|WHY|CLASS)\s*:/i.test(l)) ?? "";
  }
  return { verdict, quadrant, class: cls, reason };
}

/** Extract a BOT-SAFE / DESIGN-FORK CLASS token from a gate response, if
 *  present. Returns undefined when there's no parseable CLASS line (the
 *  single-task slop-screen path, which never asks for one). */
export function parseGateClass(raw: string): JudgmentClass | undefined {
  const cMatch = raw.match(/CLASS:[\s*]*(BOT-?SAFE|DESIGN-?FORK)\b/i);
  if (!cMatch) return undefined;
  return /design/i.test(cMatch[1]) ? "design-fork" : "bot-safe";
}

/** POST the system+user pair to OpenRouter, AbortController-bounded. Mirrors
 *  reviewer.ts's invokeOpenRouterReviewer, adding a system message. Throws on
 *  any failure (caller maps to an "error" verdict). */
async function invokeGate(
  system: string,
  user: string,
  model: string,
  apiKey: string,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
        max_tokens: 2000,
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

export interface RunJudgmentGateOptions {
  model?: string;
  promptPath?: string;
  timeoutMs?: number;
}

/** Run the judgment gate against one picked task. Always resolves (never
 *  rejects) — infrastructure failures become verdict "error" so the caller
 *  can proceed. Only an explicit "reject" under `skip` mode skips a cycle. */
export async function runJudgmentGate(
  project: { id: string; notes?: string },
  task: { id: string; title?: string },
  opts: RunJudgmentGateOptions = {},
): Promise<JudgmentVerdict> {
  const ts = new Date().toISOString();
  const model =
    opts.model ??
    process.env.GENERALSTAFF_JUDGMENT_GATE_MODEL ??
    DEFAULT_GATE_MODEL;
  const startedAt = Date.now();
  const dur = () => (Date.now() - startedAt) / 1000;
  const errVerdict = (reason: string): JudgmentVerdict => ({
    verdict: "error",
    reason,
    duration_sec: dur(),
    model,
    ts,
  });

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return errVerdict(
      "OPENROUTER_API_KEY not set — judgment gate skipped, cycle proceeds " +
        "(BYOK per Hard Rule 8; set judgment_gate: off to silence).",
    );
  }

  let system: string;
  try {
    system = await loadGatePrompt(opts.promptPath);
  } catch (err) {
    return errVerdict(
      `gate prompt unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const goal = buildGateGoal(project);
  const action = task.title?.trim() || task.id;
  const user = buildGateUserPrompt(goal, action);

  let raw: string;
  try {
    raw = await invokeGate(
      system,
      user,
      model,
      apiKey,
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return errVerdict(
      aborted
        ? `gate call timed out after ${(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s`
        : `gate call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = parseGateVerdict(raw);
  return {
    verdict: parsed.verdict,
    reason: parsed.reason || "(no reason given)",
    quadrant: parsed.quadrant,
    raw_output: raw,
    duration_sec: dur(),
    model,
    ts,
  };
}

// --- Autonomous-mode GATE+CLASSIFY (gs-332, 2026-06-22, v0.8.0) ---
// One combined pass per project: the Hammerstein system-prompt judges each
// scoped item KEEP/REJECT *and* classifies it BOT-SAFE/DESIGN-FORK. Faithful
// port of wintermute's gate_classify, refined to run per-project (robust
// ordering — no dependence on the model echoing `=== PROJECT ===` headers)
// while keeping the verdict+class combined in a single call (the plan's
// "single GATE+CLASSIFY call, not two" decision).

/** The classify user-turn. Sends the RAW scoper output (full numbered list
 *  with each item's title, "why load-bearing" sentence, and [MECHANICAL]/
 *  [DESIGN] hint) plus a project header — matching wintermute's gate_classify,
 *  which judges with that full context rather than titles alone. Paired with
 *  loadGatePrompt() as the system message. */
export function buildClassifyUserPrompt(
  project: { id: string; notes?: string },
  scopeText: string,
): string {
  const header =
    `Project: ${project.id}` +
    (project.notes?.trim() ? ` — ${project.notes.trim()}` : "");
  return (
    "Apply the framework above as a PRE-EXECUTION GATE on the proposed project " +
    "work items below. For EACH numbered item, output exactly three lines, in " +
    "the item's order:\n" +
    "VERDICT: KEEP or REJECT\n" +
    "WHY: short reason (REJECT = stupid-industrious / busywork / premature)\n" +
    "CLASS: BOT-SAFE (mechanical, bounded, no taste/feel/scope/revenue/legal " +
    "judgment; safe to auto-dispatch) or DESIGN-FORK (needs a human taste/scope/" +
    "revenue/legal call; must NOT be auto-dispatched).\n" +
    "Go item by item, in order. No preamble.\n\n" +
    header +
    "\n\nPROPOSED ITEMS:\n" +
    scopeText
  );
}

/** Parse the classify response into per-item {verdict, class, reason}, in
 *  order. Pairs each CLASS with the most-recent preceding VERDICT (faithful
 *  port of wintermute's parse_judged_by_proj `pend` logic) — robust to extra
 *  prose between items. Accepts a reason either inline on the VERDICT line or
 *  on a separate WHY line (the 3-line format the prompt requests). An item is
 *  only emitted when its CLASS line is seen. */
export function parseClassifiedItems(
  raw: string,
): Array<{ verdict: JudgmentVerdictKind; class: JudgmentClass; reason: string }> {
  const text = stripThink(raw);
  const out: Array<{
    verdict: JudgmentVerdictKind;
    class: JudgmentClass;
    reason: string;
  }> = [];
  let pendVerdict: JudgmentVerdictKind | null = null;
  let pendReason = "";
  for (const line of text.split(/\r?\n/)) {
    const vm = line.match(/VERDICT:[\s*]*(KEEP|REJECT)\b/i);
    if (vm) {
      pendVerdict = vm[1].toUpperCase() === "REJECT" ? "reject" : "keep";
      // A reason may ride inline on the VERDICT line (older 2-line format).
      const rm = line.match(
        /VERDICT:[\s*]*(?:KEEP|REJECT)\b[\s*]*[—\-:]*\s*(.*)$/i,
      );
      pendReason = rm?.[1]?.trim() ?? "";
      continue;
    }
    // A standalone WHY line (3-line format) overrides the inline reason.
    const wm = line.match(/WHY:[\s*]*(.+?)[\s*]*$/i);
    if (wm && pendVerdict) {
      pendReason = wm[1].trim();
      continue;
    }
    const cm = line.match(/CLASS:[\s*]*(BOT-?SAFE|DESIGN-?FORK)\b/i);
    if (cm) {
      out.push({
        verdict: pendVerdict ?? "error",
        class: /design/i.test(cm[1]) ? "design-fork" : "bot-safe",
        reason: pendReason,
      });
      pendVerdict = null;
      pendReason = "";
    }
  }
  return out;
}

// The classify gate, like the scoper, is a reasoning model on a multi-item
// prompt — give it the same generous budget the single-task slop screen's 60s
// default would overrun. Override via RunClassifyGateOptions.timeoutMs.
const DEFAULT_CLASSIFY_TIMEOUT_MS = 150_000;

export interface RunClassifyGateOptions {
  model?: string;
  promptPath?: string;
  timeoutMs?: number;
  apiKey?: string;
}

/** Run the combined GATE+CLASSIFY pass for one project's scoped items. `items`
 *  is the parsed list (used to align verdicts back by order); `scopeText` is
 *  the RAW scoper output the gate actually reads (full why/tag context).
 *  Gracefully degrades — a missing key / prompt-load / fetch failure yields an
 *  "error" verdict (no class) for every item rather than throwing, matching
 *  runJudgmentGate's documented no-op-on-infra-failure contract. Items the
 *  model failed to classify also default to "error" (needs-human; never
 *  auto-dispatched). */
export async function runClassifyGate(
  project: { id: string; notes?: string },
  items: ScopedItem[],
  scopeText: string,
  opts: RunClassifyGateOptions = {},
): Promise<ClassifiedItem[]> {
  if (items.length === 0) return [];
  const errItems = (): ClassifiedItem[] =>
    items.map((it) => ({ title: it.title, verdict: "error" as const }));

  const model =
    opts.model ??
    process.env.GENERALSTAFF_JUDGMENT_GATE_MODEL ??
    DEFAULT_GATE_MODEL;
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) return errItems();

  let system: string;
  try {
    system = await loadGatePrompt(opts.promptPath);
  } catch {
    return errItems();
  }

  const user = buildClassifyUserPrompt(project, scopeText);
  let raw: string;
  try {
    raw = await invokeGate(
      system,
      user,
      model,
      apiKey,
      opts.timeoutMs ?? DEFAULT_CLASSIFY_TIMEOUT_MS,
    );
  } catch {
    return errItems();
  }

  const parsed = parseClassifiedItems(raw);
  return items.map((it, i) => ({
    title: it.title,
    verdict: parsed[i]?.verdict ?? "error",
    class: parsed[i]?.class,
    reason: parsed[i]?.reason,
  }));
}
