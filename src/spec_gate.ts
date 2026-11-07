// GeneralStaff — spec-anchor gate (v0.18.0)
//
// The judgment gate asks "is this task load-bearing or slop?". It never reads
// what the owner asked for. This gate does: it checks one picked task against
// the project's SPEC.md (the owner's own words) and answers "does this task
// build what the owner asked for?". See docs/SPEC-GATE.md.
//
// Design constraints:
//   - Zero overhead when spec_gate is "off" / unset (the caller short-circuits).
//   - The model reads ONLY the anchor and the card, never the plan or other tasks.
//   - Fail closed in block mode: OFF-SPEC, UNCLEAR and error all skip the cycle.
//     The one exception is a missing anchor file, which warns and proceeds.
//   - Only a normally completed, schema-valid reply counts as a verdict. A
//     timeout, a non-stop finish reason, empty or malformed output is "error".
//   - Additive: the judgment gate and the reviewer are not touched.

import { createHash } from "crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { assertNotVerifyOnly } from "./verify_only/guard";
import { DEFAULT_GATE_MODEL } from "./judgment_gate";
import {
  ProviderConfigError,
  getProviderForRole,
  hasProviderForRole,
  loadProviderRegistry,
} from "./providers/registry";
import type {
  GreenfieldTask,
  SpecGateMode,
  SpecTaskKind,
  SpecVerdictKind,
} from "./types";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_REPLY_TOKENS = 2000;
export const DEFAULT_SPEC_ANCHOR = "SPEC.md";
export const SPEC_CHECKS_FILE = "spec_checks.jsonl";
/** An owner_quote shorter than this (after whitespace normalisation) cannot
 *  count: a few characters match almost any file. */
export const MIN_OWNER_QUOTE_CHARS = 10;
/** An override reason needs to say something: at least this many words. */
export const MIN_OVERRIDE_WORDS = 3;

// --- Prompt asset ---

const BEGIN_MARKER = /^## === BEGIN SYSTEM PROMPT ===\s*$/m;
const END_MARKER = /^## === END SYSTEM PROMPT ===\s*$/m;
const VERSION_LINE = /^Version:\s*(\d+)\s*$/m;

export interface SpecPrompt {
  version: number;
  text: string;
}

let cachedPrompt: { path: string; prompt: SpecPrompt } | null = null;

function defaultPromptPath(): string {
  return join(import.meta.dir, "prompts", "spec_gate.md");
}

/** Load the bundled prompt: the text between the BEGIN/END marker lines and
 *  the `Version: N` line above it. Throws when either is missing. */
export function loadSpecPrompt(promptPath?: string): SpecPrompt {
  const path = promptPath ?? defaultPromptPath();
  if (cachedPrompt && cachedPrompt.path === path) return cachedPrompt.prompt;
  const raw = readFileSync(path, "utf8");
  const begin = raw.match(BEGIN_MARKER);
  const end = raw.match(END_MARKER);
  if (
    !begin ||
    !end ||
    begin.index === undefined ||
    end.index === undefined ||
    end.index <= begin.index
  ) {
    throw new Error(`spec gate prompt ${path} missing BEGIN/END SYSTEM PROMPT markers`);
  }
  const versionMatch = raw.slice(0, begin.index).match(VERSION_LINE);
  if (!versionMatch) {
    throw new Error(`spec gate prompt ${path} has no "Version: N" line before the BEGIN marker`);
  }
  const text = raw.slice(begin.index + begin[0].length, end.index).trim();
  if (!text) throw new Error(`spec gate prompt ${path} is empty between markers`);
  const prompt = { version: parseInt(versionMatch[1]!, 10), text };
  cachedPrompt = { path, prompt };
  return prompt;
}

/** Test seam: drop the cached prompt. */
export function _resetSpecPromptCacheForTests(): void {
  cachedPrompt = null;
}

// --- Cards ---

export interface SpecCard {
  id: string;
  title: string;
  /** Free-text description / body of the card. */
  body?: string;
  user_facing?: boolean;
  owner_words?: string | string[];
  owner_quote?: { text: string; source: string };
  first_screen?: string;
}

/** Build a card from a tasks.json entry. Any of description/body/notes/details
 *  that is a string becomes the card body. */
export function cardFromTask(task: GreenfieldTask): SpecCard {
  const rec = task as unknown as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["description", "body", "notes", "details"]) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) parts.push(v.trim());
  }
  const card: SpecCard = { id: task.id, title: task.title };
  if (parts.length) card.body = parts.join("\n\n");
  if (task.user_facing !== undefined) card.user_facing = task.user_facing === true;
  if (task.owner_words !== undefined) card.owner_words = task.owner_words;
  if (task.owner_quote !== undefined) card.owner_quote = task.owner_quote;
  if (task.first_screen !== undefined) card.first_screen = task.first_screen;
  return card;
}

/** Collapse every run of whitespace to one space and trim. */
export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

const OWNER_ASK_LINE = /^[ \t]*OWNER-ASK:[ \t]*(?:"([^"\n]+)"|“([^”\n]+)”)[ \t]*$/gim;

/** Owner words from `OWNER-ASK: "<words>"` lines in free text. */
export function extractOwnerAsk(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(OWNER_ASK_LINE)) {
    const words = (m[1] ?? m[2] ?? "").trim();
    if (words) out.push(words);
  }
  return out;
}

// --- Owner quotes ---

export interface QuoteCheck {
  ok: boolean;
  /** Why it counts or why not. */
  reason: string;
  source?: string;
}

function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

/** True when `target` is `root` or inside it, after resolving symlinks. */
function insideRoot(root: string, target: string): boolean {
  try {
    const rel = relative(realpathSync(root), realpathSync(target));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
  } catch {
    return false;
  }
}

/** Mechanically check an owner_quote: the file must be listed in owner_docs,
 *  must exist inside the project, and `text` must occur verbatim in it
 *  (whitespace-normalised). A paraphrase never counts. The `#section` part of
 *  `source` is recorded, not checked. */
export function verifyOwnerQuote(
  quote: unknown,
  projectPath: string,
  ownerDocs: readonly string[],
): QuoteCheck {
  if (
    !quote ||
    typeof quote !== "object" ||
    typeof (quote as { text?: unknown }).text !== "string" ||
    typeof (quote as { source?: unknown }).source !== "string"
  ) {
    return { ok: false, reason: "owner_quote must be { text, source }" };
  }
  const { text, source } = quote as { text: string; source: string };
  const file = normalizeRelPath(source.split("#")[0] ?? "").trim();
  const wanted = normalizeWhitespace(text);
  if (!file) return { ok: false, reason: "owner_quote.source has no file path", source };
  if (wanted.length < MIN_OWNER_QUOTE_CHARS) {
    return {
      ok: false,
      reason: `owner_quote.text is shorter than ${MIN_OWNER_QUOTE_CHARS} characters`,
      source,
    };
  }
  const listed = ownerDocs.map(normalizeRelPath);
  if (!listed.includes(file)) {
    return { ok: false, reason: `${file} is not listed in owner_docs`, source };
  }
  const abs = resolve(projectPath, file);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    return { ok: false, reason: `owner doc ${file} does not exist`, source };
  }
  if (!insideRoot(projectPath, abs)) {
    return { ok: false, reason: `owner doc ${file} is outside the project`, source };
  }
  const haystack = normalizeWhitespace(readFileSync(abs, "utf8"));
  if (!haystack.includes(wanted)) {
    return { ok: false, reason: `quote not found verbatim in ${file}`, source };
  }
  return { ok: true, reason: `quote found verbatim in ${file}`, source };
}

// --- Owner words and picture checks (mechanical) ---

export interface OwnerWordsEval {
  present: boolean;
  /** Free-text owner words: task field plus OWNER-ASK lines. */
  words: string[];
  /** The owner_quote, when one was given and verified. */
  quote?: { text: string; source: string };
  /** Why a given owner_quote does not count. */
  quoteProblem?: string;
}

export interface SpecProjectContext {
  id?: string;
  path: string;
  spec_anchor?: string;
  owner_docs?: string[];
  picture_first?: boolean;
}

/** Fewest words an owner_words entry or OWNER-ASK line needs to count. */
export const MIN_OWNER_WORDS = 3;

export function evaluateOwnerWords(
  card: SpecCard,
  project: Pick<SpecProjectContext, "path" | "owner_docs">,
): OwnerWordsEval {
  const words: string[] = [];
  const field = card.owner_words;
  for (const w of Array.isArray(field) ? field : field !== undefined ? [field] : []) {
    if (typeof w === "string") words.push(w.trim());
  }
  words.push(...extractOwnerAsk(`${card.title}\n${card.body ?? ""}`));
  // Owner words are a sentence for the feature, not a one-word yes: at least
  // MIN_OWNER_WORDS words, the same floor the fork ledger uses for a ruling.
  const kept = words.filter((w) => w.split(/\s+/).filter(Boolean).length >= MIN_OWNER_WORDS);
  words.length = 0;
  words.push(...kept);
  const out: OwnerWordsEval = { present: false, words };
  if (card.owner_quote !== undefined) {
    const check = verifyOwnerQuote(card.owner_quote, project.path, project.owner_docs ?? []);
    if (check.ok) out.quote = card.owner_quote;
    else out.quoteProblem = check.reason;
  }
  out.present = words.length > 0 || out.quote !== undefined;
  return out;
}

const PICTURE_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp", ".html", ".htm",
];

/** True when first_screen names an existing image or HTML file inside the project. */
export function firstScreenExists(projectPath: string, firstScreen: unknown): boolean {
  if (typeof firstScreen !== "string" || !firstScreen.trim()) return false;
  const rel = normalizeRelPath(firstScreen.trim());
  if (isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.split("/").includes("..")) return false;
  const lower = rel.toLowerCase();
  if (!PICTURE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return false;
  const abs = resolve(projectPath, rel);
  try {
    return statSync(abs).isFile() && insideRoot(projectPath, abs);
  } catch {
    return false;
  }
}

export interface MechanicalCheck {
  /** Reasons the card is refused without calling the model. Empty = go on. */
  problems: string[];
  owner: OwnerWordsEval;
  firstScreenOk?: boolean;
}

/** The deterministic part: a user-facing build card needs owner words, and
 *  with picture_first it needs a first-screen picture. A fix that restores
 *  approved behaviour is simply not marked user_facing; the exemption is never
 *  read from the title. */
export function mechanicalChecks(card: SpecCard, project: SpecProjectContext): MechanicalCheck {
  const owner = evaluateOwnerWords(card, project);
  const problems: string[] = [];
  const result: MechanicalCheck = { problems, owner };
  if (card.user_facing === true) {
    if (!owner.present) {
      problems.push(
        "no owner words for this feature" +
          (owner.quoteProblem ? ` (owner_quote does not count: ${owner.quoteProblem})` : ""),
      );
    }
    if (project.picture_first === true) {
      result.firstScreenOk = firstScreenExists(project.path, card.first_screen);
      if (!result.firstScreenOk) problems.push("no first-screen picture");
    }
  }
  return result;
}

// --- Card text (prompt body and cache key) ---

export function renderCardText(card: SpecCard, owner: OwnerWordsEval, firstScreenOk?: boolean): string {
  const lines: string[] = [
    `id: ${card.id}`,
    `title: ${card.title}`,
    `user_facing: ${card.user_facing === true ? "true" : "false"}`,
    `owner words present: ${owner.present ? "yes" : "no"}`,
  ];
  if (owner.words.length) {
    lines.push("owner words (verbatim):");
    for (const w of owner.words) lines.push(`- ${w}`);
  }
  if (owner.quote) {
    lines.push(`verified quote from ${owner.quote.source} (found verbatim): ${normalizeWhitespace(owner.quote.text)}`);
  } else if (owner.quoteProblem) {
    lines.push(`owner_quote given but it does not count: ${owner.quoteProblem}`);
  }
  if (firstScreenOk !== undefined) {
    lines.push(`first-screen picture: ${firstScreenOk ? "present" : "absent"}`);
  }
  if (card.body?.trim()) {
    lines.push("description:", card.body.trim());
  }
  return lines.join("\n");
}

export function buildSpecUserPrompt(anchorText: string, cardText: string): string {
  return (
    `ANCHOR:\n<<<\n${anchorText.trim()}\n>>>\n\n` +
    `CARD:\n<<<\n${cardText}\n>>>\n\n` +
    "Check the card against the anchor. Reply with the one JSON object described in your instructions."
  );
}

export function specCacheKey(promptVersion: number, anchorText: string, cardText: string): string {
  return createHash("sha256")
    .update(JSON.stringify([promptVersion, anchorText, cardText]))
    .digest("hex");
}

// --- Verdict parsing ---

export interface ParsedSpecVerdict {
  kind: SpecTaskKind;
  verdict: Exclude<SpecVerdictKind, "error">;
  user_can: string;
  anchor_step: string;
  reason: string;
  owner_words_present: boolean;
  stand_in: boolean;
}

const KINDS: readonly SpecTaskKind[] = ["build", "verify", "ship"];

function stripReply(raw: string): string {
  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fence = s.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n```$/);
  if (fence) s = fence[1]!.trim();
  return s;
}

/** Parse and schema-validate the checker's reply. Anything else is an error:
 *  prose around the JSON, a missing or mistyped key, an unknown enum value, or
 *  a stand_in that does not go with an OFF-SPEC verdict. */
export function parseSpecVerdict(raw: string): { ok: true; value: ParsedSpecVerdict } | { ok: false; error: string } {
  const text = stripReply(raw);
  if (!text) return { ok: false, error: "empty reply" };
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return { ok: false, error: "reply is not a single JSON object" };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, error: "reply is not a JSON object" };
  }
  const o = obj as Record<string, unknown>;
  const kind = typeof o.kind === "string" ? (o.kind.toLowerCase() as SpecTaskKind) : undefined;
  if (!kind || !KINDS.includes(kind)) {
    return { ok: false, error: `kind must be one of ${KINDS.join(", ")}` };
  }
  const v = typeof o.verdict === "string" ? o.verdict.toUpperCase() : "";
  const verdict = v === "ON-SPEC" ? "on-spec" : v === "OFF-SPEC" ? "off-spec" : v === "UNCLEAR" ? "unclear" : null;
  if (!verdict) return { ok: false, error: "verdict must be ON-SPEC, OFF-SPEC or UNCLEAR" };
  for (const key of ["user_can", "anchor_step", "reason"] as const) {
    if (typeof o[key] !== "string") return { ok: false, error: `${key} must be a string` };
  }
  if (!(o.reason as string).trim()) return { ok: false, error: "reason must not be empty" };
  if (typeof o.owner_words_present !== "boolean") {
    return { ok: false, error: "owner_words_present must be a boolean" };
  }
  if (typeof o.stand_in !== "boolean") return { ok: false, error: "stand_in must be a boolean" };
  if (o.stand_in && verdict !== "off-spec") {
    return { ok: false, error: "stand_in is true but the verdict is not OFF-SPEC" };
  }
  return {
    ok: true,
    value: {
      kind,
      verdict,
      user_can: (o.user_can as string).trim(),
      anchor_step: (o.anchor_step as string).trim(),
      reason: (o.reason as string).trim(),
      owner_words_present: o.owner_words_present,
      stand_in: o.stand_in,
    },
  };
}

// --- Verdict record and decisions ---

export interface SpecVerdict {
  verdict: SpecVerdictKind;
  kind?: SpecTaskKind;
  user_can?: string;
  anchor_step?: string;
  reason: string;
  owner_words_present: boolean;
  stand_in: boolean;
  /** How the verdict was reached. */
  source: "model" | "cache" | "mechanical" | "none";
  /** True when the anchor file is missing or empty: warn and proceed. */
  no_anchor?: boolean;
  model?: string;
  key?: string;
  duration_sec: number;
  ts: string;
  raw_output?: string;
}

/** Cycle reason code for a refusal: `spec_gate_off_spec`, `spec_gate_unclear`, `spec_gate_error`. */
export function specGateReasonCode(verdict: SpecVerdictKind): string {
  return `spec_gate_${verdict.replace("-", "_")}`;
}

/** Whether block mode refuses this verdict (before any override). */
export function shouldSpecGateBlock(mode: SpecGateMode, v: Pick<SpecVerdict, "verdict" | "no_anchor">): boolean {
  if (mode !== "block") return false;
  if (v.no_anchor) return false;
  return v.verdict !== "on-spec";
}

export type OverrideCheck =
  | { status: "none" }
  | { status: "invalid"; error: string }
  | { status: "valid"; reason: string };

/** Read an override reason. It must be non-empty and at least a few words. */
export function parseOverride(raw: string | undefined | null): OverrideCheck {
  if (raw === undefined || raw === null) return { status: "none" };
  const reason = raw.trim();
  if (!reason) return { status: "invalid", error: "override reason is empty" };
  if (reason.split(/\s+/).length < MIN_OVERRIDE_WORDS) {
    return {
      status: "invalid",
      error: `override reason needs at least ${MIN_OVERRIDE_WORDS} words saying why`,
    };
  }
  return { status: "valid", reason };
}

export interface SpecDecision {
  proceed: boolean;
  /** Set when the card is refused: the cycle reason code. */
  reasonCode?: string;
  /** Set when an override let a blocked card proceed. */
  overridden?: { reason: string };
  /** Why an override was ignored (invalid reason, or a stand-in). */
  overrideNote?: string;
}

/** The one decision the cycle site consults: mode + verdict + optional
 *  override. An override never passes a verdict with stand_in true. */
export function decideSpecGate(mode: SpecGateMode, v: SpecVerdict, override: OverrideCheck = { status: "none" }): SpecDecision {
  if (!shouldSpecGateBlock(mode, v)) return { proceed: true };
  const reasonCode = specGateReasonCode(v.verdict);
  if (override.status === "none") return { proceed: false, reasonCode };
  if (override.status === "invalid") {
    return { proceed: false, reasonCode, overrideNote: override.error };
  }
  if (v.stand_in) {
    return {
      proceed: false,
      reasonCode,
      overrideNote: "an override cannot pass a stand-in verdict",
    };
  }
  return { proceed: true, overridden: { reason: override.reason } };
}

// --- Cache and log (state/<project>/spec_checks.jsonl) ---

export interface SpecCheckRecord {
  ts: string;
  /** "verdict" (default) or "override". */
  record?: "verdict" | "override";
  task_id: string;
  /** Null for mechanical verdicts and overrides: they are never cache hits. */
  key: string | null;
  model?: string;
  verdict: SpecVerdictKind;
  source?: string;
  kind?: SpecTaskKind;
  user_can?: string;
  anchor_step?: string;
  reason: string;
  owner_words_present?: boolean;
  stand_in?: boolean;
  override_reason?: string;
}

export function specChecksPath(stateDirForProject: string): string {
  return join(stateDirForProject, SPEC_CHECKS_FILE);
}

/** Read the log; malformed lines are skipped. */
export function readSpecChecks(path: string): SpecCheckRecord[] {
  if (!existsSync(path)) return [];
  const out: SpecCheckRecord[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as SpecCheckRecord;
      if (rec && typeof rec === "object" && typeof rec.task_id === "string" && typeof rec.verdict === "string") {
        out.push(rec);
      }
    } catch {
      // skip a damaged line
    }
  }
  return out;
}

export function appendSpecCheck(path: string, rec: SpecCheckRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(rec) + "\n");
}

/** The cached verdict for this key, if a valid one exists. Errors, mechanical
 *  verdicts and overrides are never hits. */
export function lookupSpecCache(path: string, key: string): SpecCheckRecord | undefined {
  const hits = readSpecChecks(path).filter(
    (r) => r.key === key && r.verdict !== "error" && (r.record ?? "verdict") === "verdict" && r.source !== "mechanical",
  );
  return hits[hits.length - 1];
}

/** Log an override next to the verdicts. */
export function recordSpecOverride(path: string, taskId: string, v: SpecVerdict, reason: string): void {
  appendSpecCheck(path, {
    ts: new Date().toISOString(),
    record: "override",
    task_id: taskId,
    key: null,
    verdict: v.verdict,
    reason: v.reason,
    stand_in: v.stand_in,
    override_reason: reason,
  });
}

// --- The checker backend ---

export interface CheckerReply {
  content?: string;
  finish_reason?: string | null;
  error?: string;
  model: string;
}

export type SpecChecker = (system: string, user: string, opts: { timeoutMs: number }) => Promise<CheckerReply>;

async function openRouterChecker(system: string, user: string, model: string, timeoutMs: number): Promise<CheckerReply> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return {
      model,
      error:
        "OPENROUTER_API_KEY not set and no spec_checker route in provider_config.yaml " +
        "(BYOK per Hard Rule 8)",
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
        max_tokens: MAX_REPLY_TOKENS,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      return { model, error: `OpenRouter ${response.status} ${response.statusText}: ${body.slice(0, 800)}` };
    }
    const data = (await response.json()) as {
      error?: unknown;
      choices?: Array<{
        message?: { content?: string };
        finish_reason?: string | null;
        error?: unknown;
      }>;
    };
    const choice = data?.choices?.[0];
    if (data?.error || choice?.error) {
      return {
        model,
        error: `OpenRouter returned an error payload: ${JSON.stringify(data.error ?? choice?.error).slice(0, 800)}`,
      };
    }
    const content = choice?.message?.content;
    if (typeof content !== "string") {
      return { model, error: `OpenRouter response missing content: ${JSON.stringify(data).slice(0, 800)}` };
    }
    return { model, content, finish_reason: choice?.finish_reason ?? undefined };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      model,
      error: aborted
        ? `spec checker timed out after ${timeoutMs / 1000}s`
        : `spec checker call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface ResolveCheckerOptions {
  /** Path to provider_config.yaml; defaults to the registry's own default. */
  providerConfigPath?: string;
  /** Inline-path model override; defaults to GENERALSTAFF_SPEC_GATE_MODEL, then the judgment gate's model. */
  model?: string;
}

/** Pick the backend: the `spec_checker` route in provider_config.yaml when
 *  there is one, else an inline OpenRouter call. Never throws: a broken
 *  provider config comes back as an error reply so the gate fails closed
 *  instead of quietly using a different backend. */
export function resolveSpecChecker(opts: ResolveCheckerOptions = {}): SpecChecker {
  return async (system, user, { timeoutMs }) => {
    const fallbackModel = opts.model ?? process.env.GENERALSTAFF_SPEC_GATE_MODEL ?? DEFAULT_GATE_MODEL;
    let registry;
    try {
      registry = await loadProviderRegistry(opts.providerConfigPath);
    } catch (err) {
      return {
        model: fallbackModel,
        error: `provider_config.yaml unreadable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!hasProviderForRole(registry, "spec_checker")) {
      return openRouterChecker(system, user, fallbackModel, timeoutMs);
    }
    const id = registry.routes.spec_checker;
    const model = registry.providers.get(id)?.model ?? id;
    try {
      const provider = getProviderForRole(registry, "spec_checker");
      const res = await provider.invoke(`${system}\n\n---\n\n${user}`, {
        timeoutMs,
        maxTokens: MAX_REPLY_TOKENS,
        temperature: 0,
      });
      if (res.error) return { model, error: res.error };
      return { model, content: res.content, finish_reason: res.finish_reason };
    } catch (err) {
      const msg = err instanceof ProviderConfigError ? err.message : String(err);
      return { model, error: `spec_checker provider failed: ${msg}` };
    }
  };
}

// --- Running the gate ---

export interface RunSpecGateOptions {
  checker?: SpecChecker;
  timeoutMs?: number;
  promptPath?: string;
  providerConfigPath?: string;
  /** Where to read and write the verdict log. Null/undefined = no cache. */
  checksPath?: string | null;
}

export interface CheckAgainstAnchorInput {
  /** Text of the anchor, or null when there is none. */
  anchorText: string | null;
  anchorLabel: string;
  card: SpecCard;
  project: SpecProjectContext;
}

function elapsed(startedAt: number): number {
  return (Date.now() - startedAt) / 1000;
}

/** Check one card against an anchor. Always resolves; infrastructure failure
 *  is a verdict of "error" (which block mode treats as a refusal). */
export async function checkCardAgainstAnchor(
  input: CheckAgainstAnchorInput,
  opts: RunSpecGateOptions = {},
): Promise<SpecVerdict> {
  assertNotVerifyOnly("the spec-anchor gate");
  const startedAt = Date.now();
  const ts = new Date().toISOString();
  const { card, project } = input;
  const base = { ts, source: "none" as SpecVerdict["source"] };
  const mech = mechanicalChecks(card, project);
  const ownerPresent = mech.owner.present;

  if (input.anchorText === null || !input.anchorText.trim()) {
    return {
      ...base,
      verdict: "error",
      no_anchor: true,
      reason: `no anchor: ${input.anchorLabel} is missing or empty; spec gate skipped`,
      owner_words_present: ownerPresent,
      stand_in: false,
      duration_sec: elapsed(startedAt),
    };
  }

  const finish = (v: SpecVerdict, logIt: boolean): SpecVerdict => {
    if (logIt && opts.checksPath) {
      try {
        appendSpecCheck(opts.checksPath, {
          ts,
          task_id: card.id,
          key: v.source === "model" ? (v.key ?? null) : null,
          model: v.model,
          verdict: v.verdict,
          source: v.source,
          kind: v.kind,
          user_can: v.user_can,
          anchor_step: v.anchor_step,
          reason: v.reason,
          owner_words_present: v.owner_words_present,
          stand_in: v.stand_in,
        });
      } catch {
        // a log that cannot be written must not change the verdict
      }
    }
    return v;
  };

  if (mech.problems.length > 0) {
    return finish(
      {
        ...base,
        source: "mechanical",
        verdict: "unclear",
        reason: mech.problems.join("; "),
        owner_words_present: ownerPresent,
        stand_in: false,
        duration_sec: elapsed(startedAt),
      },
      true,
    );
  }

  let prompt: SpecPrompt;
  try {
    prompt = loadSpecPrompt(opts.promptPath);
  } catch (err) {
    return {
      ...base,
      verdict: "error",
      reason: `spec gate prompt unavailable: ${err instanceof Error ? err.message : String(err)}`,
      owner_words_present: ownerPresent,
      stand_in: false,
      duration_sec: elapsed(startedAt),
    };
  }

  const cardText = renderCardText(card, mech.owner, mech.firstScreenOk);
  const key = specCacheKey(prompt.version, input.anchorText, cardText);

  if (opts.checksPath) {
    const hit = lookupSpecCache(opts.checksPath, key);
    if (hit) {
      return {
        ...base,
        source: "cache",
        verdict: hit.verdict,
        kind: hit.kind,
        user_can: hit.user_can,
        anchor_step: hit.anchor_step,
        reason: hit.reason,
        owner_words_present: ownerPresent,
        stand_in: hit.stand_in === true,
        model: hit.model,
        key,
        duration_sec: elapsed(startedAt),
      };
    }
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const checker = opts.checker ?? resolveSpecChecker({ providerConfigPath: opts.providerConfigPath });
  const user = buildSpecUserPrompt(input.anchorText, cardText);
  let reply: CheckerReply;
  try {
    reply = await checker(prompt.text, user, { timeoutMs });
  } catch (err) {
    reply = { model: "unknown", error: `spec checker threw: ${err instanceof Error ? err.message : String(err)}` };
  }
  const errorVerdict = (reason: string): SpecVerdict => ({
    ...base,
    verdict: "error",
    reason,
    owner_words_present: ownerPresent,
    stand_in: false,
    model: reply.model,
    key,
    duration_sec: elapsed(startedAt),
    raw_output: reply.content?.slice(0, 4000),
  });

  if (reply.error) return errorVerdict(reply.error);
  const stop = reply.finish_reason;
  if (stop && stop.toLowerCase() !== "stop") {
    return errorVerdict(`checker stopped with finish_reason=${stop}; the reply is incomplete`);
  }
  if (typeof reply.content !== "string" || !reply.content.trim()) {
    return errorVerdict("checker returned an empty reply");
  }
  const parsed = parseSpecVerdict(reply.content);
  if (!parsed.ok) return errorVerdict(`checker reply rejected: ${parsed.error}`);

  const p = parsed.value;
  return finish(
    {
      ...base,
      source: "model",
      verdict: p.verdict,
      kind: p.kind,
      user_can: p.user_can,
      anchor_step: p.anchor_step,
      reason: p.reason,
      // The presence check is mechanical; the model's claim is not trusted.
      owner_words_present: ownerPresent,
      stand_in: p.stand_in,
      model: reply.model,
      key,
      duration_sec: elapsed(startedAt),
      raw_output: reply.content.slice(0, 4000),
    },
    true,
  );
}

/** Resolve a project's anchor path (project root + spec_anchor, default SPEC.md). */
export function resolveAnchorPath(project: Pick<SpecProjectContext, "path" | "spec_anchor">): string {
  return resolve(project.path, project.spec_anchor ?? DEFAULT_SPEC_ANCHOR);
}

/** Read the anchor. With `projectRoot`, an anchor that resolves (symlinks
 *  included) outside the project is not read and counts as missing. */
export function readAnchor(path: string, projectRoot?: string): string | null {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null;
    if (projectRoot !== undefined && !insideRoot(projectRoot, path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Run the gate for one picked task of a registered project. */
export async function runSpecGate(
  project: SpecProjectContext & { id: string },
  task: GreenfieldTask,
  opts: RunSpecGateOptions = {},
): Promise<SpecVerdict> {
  const anchorPath = resolveAnchorPath(project);
  return checkCardAgainstAnchor(
    {
      anchorText: readAnchor(anchorPath, project.path),
      anchorLabel: project.spec_anchor ?? DEFAULT_SPEC_ANCHOR,
      card: cardFromTask(task),
      project,
    },
    opts,
  );
}
