# Rule Relaxation — 2026-04-15

**Authority:** Explicit Ray override granted in interactive session
on 2026-04-15. This file documents the changes per the protocol in
`CLAUDE.md`: "existing rules cannot be relaxed without an explicit
RULE-RELAXATION-<date>.md log file documenting why."

**Context:** GeneralStaff has been pivoted from a personal nightly
meta-dispatcher into an open-source product — the principled,
transparent, bring-your-own-keys alternative to Polsia. See
`PIVOT-2026-04-15.md` for the full decision and the deep-dive that
informed it.

The original Hard Rules were written for personal infra where Ray
was the only operator. They need adjustment now that the project is
becoming a product other people will run. The relaxations below are
narrowly scoped — the underlying intent of every original rule is
either preserved or strengthened.

---

## 1. Relaxed: Hard Rule #2 — "File-based state only"

### Original (from CLAUDE.md and README.md)

> "File-based state only. No databases, daemons, web dashboards,
> external orchestration. Shell + Claude Code + git + markdown/JSON.
> Every dependency is a 3 AM failure mode."

### What's changing

A **local desktop UI** is now permitted as a viewer/controller layer
over the file-based state. Implementation candidates: Tauri (Rust +
WebView, smallest binary), Electron (largest install but most
familiar), or a single-binary local HTTP server (Bun/Node) that
ships with the CLI distribution. Default lean: **Tauri** for the
shipped product, with a simple Bun-served browser tab acceptable
during development.

### What stays in force

1. **File-based state remains the single source of truth.** Every
   piece of dispatcher state (`STATE.json`, `HANDOFF.md`,
   `tasks.json`, `PROGRESS.jsonl`, `MISSION.md`, `REVIEW.md`) lives
   on disk in plain text. The UI does not introduce a database.
   The dispatcher must remain fully usable from the CLI alone, with
   the UI binary uninstalled.

2. **No persistent background daemon required.** The UI is launched
   on demand by the user; it does not need to be running for the
   dispatcher to function. The CLI must remain fully usable without
   the UI process being alive.

3. **No external SaaS orchestration.** No GeneralStaff-the-company
   in the loop. No phone-home telemetry by default. No remote
   control plane. No "log into your GeneralStaff account."

4. **UI writes go through the same code paths as the CLI.** The UI
   is a frontend over the dispatcher's existing read/write functions
   — it must not bypass validation, audit logging, or the safety
   rules. If the CLI rejects an action, the UI must reject the same
   action for the same reason.

5. **The relaxation is for *local* UI only.** A hosted dashboard
   (SaaS-style web app the user logs into through a browser at a
   GeneralStaff-owned domain) is still forbidden. The moment someone
   proposes that, this rule snaps back and a new relaxation file is
   required.

### Why this is okay

The original rule's intent was "no 3 AM failure modes from
unnecessary dependencies." A local UI binary that reads files and
exits cleanly is not a 3 AM failure mode — it's the same failure
profile as `cat STATE.json | jq`, just with a graphical surface.
The dependency is on the user's own machine, not on a remote
service.

The Polsia complaint pattern (Trustpilot 2.5/5, 14 reviews, 65%
one-star) shows that users with no UI for control end up:
- Unable to find the OFF switch when the bot makes auto-commitments
- Unable to see what credits/tasks are running
- Unable to intervene mid-cycle
- Forced to wait days for support that never comes

A thin local UI is the cheapest fix to the entire "I have no
control" complaint class. The constraint is keeping it thin and
keeping state on disk.

---

## 2. Preserved (unchanged)

The remaining original Hard Rules all stay in force, with one
strengthening note each:

### Hard Rule #1 — No creative work delegation

Engineering / correctness work only. Marketing, growth, support,
and other creative-judgment agents stay **off by default** in the
shipped product. They may exist as opt-in plugins gated behind a
`creative_work_warning_acknowledged: true` config flag, with
explicit README warnings that this is the slop-prone failure mode
Polsia ships and that the principled default is "don't."

The Hammerstein quadrant logic that created this rule applies
*more* strongly to a public product than to personal infra:
industriousness without judgment compounds negatively at scale,
and the user said it best in the 2026-04-15 session — *"the
service isn't useful if all the employees are stupid and
industrious."*

### Hard Rule #3 — Sequential MVP

One project per cycle until stability is proven. Parallel worktrees
remain a later phase, not the MVP. The product launches with
sequential semantics; parallelism is an opt-in upgrade after the
verification gate has been validated under load.

### Hard Rule #4 — Auto-merge OFF

Even more important now that strangers will run this on their own
machines. Default `auto_merge: false` is enforced in the dispatcher
startup validation. Users can flip it to `true` per project, but
only after a project has logged 5+ clean verification-passing cycles.
The dispatcher tracks this counter and refuses to honor `auto_merge:
true` if the counter is below 5.

### Hard Rule #5 — Mandatory hands-off lists

The dispatcher refuses to start with an empty `hands_off` list for
any registered project. The install wizard helps generate sensible
defaults (`.git/`, `.env`, `secrets/`, `node_modules/`, hidden
config, etc.) but the user must explicitly review and confirm them.
Empty list = no registration. Hands-off enforcement happens at the
Claude Code permission-deny level, not just in the prompt.

---

## 3. New rules added

These are the differentiators that make the open-source product
defensible against Polsia. They are now Hard Rules with the same
non-negotiable status as the originals.

### Hard Rule #6 — Verification gate is load-bearing

A cycle is **not** marked `done` until **all** of:

1. The project's `verification_command` (test suite, build, lint)
   exits 0.
2. `git diff` between cycle start and cycle end is non-empty.
3. The Reviewer agent confirms the diff scope matches the task
   description (no silent scope drift, no off-task edits).

If any of these fails, the cycle status becomes `verification_failed`,
the work is escalated to the morning digest, and the dispatcher moves
on. Polsia's #1 user complaint is "AI marks tasks complete without
verifying functionality" — this rule prevents that failure mode
structurally, at the dispatcher level, not in the model's prompt.

This rule promotes catalogdna's existing Phase A/B "ritual" into
load-bearing infrastructure. It is the single most important
technical differentiator vs. Polsia.

### Hard Rule #7 — Code ownership

The bot only ever pushes to a per-project `bot/work` branch on the
**user's own git remote**. There is no GeneralStaff-managed
repository, no platform-managed GitHub account, no opaque
intermediary. Export equals `git clone`. A user can rip GeneralStaff
out of their workflow with zero data migration.

This kills Polsia's #2 complaint class entirely ("I asked the
owner if I could export my project to my own server—there's no
option").

### Hard Rule #8 — BYOK for LLM providers

The user configures their own provider keys (`ANTHROPIC_API_KEY`,
`OPENROUTER_API_KEY`, etc.). There is no platform credit system, no
opaque "task credits," no revenue share on businesses operated by
the bot. LLM costs go directly to the user's bill from their chosen
provider.

Subscription-based use (Claude Code subscription quota for headless
runs) is permitted as a **personal-use opt-in only**, gated behind
a documentation note about Anthropic's ToS for programmatic /
multi-tenant use. The default configuration is API-key BYOK because
that is unambiguously within ToS. ToS clarification is an open
question — see §4 below.

### Hard Rule #9 — Open audit log

Every cycle writes the following to `.generalstaff/PROGRESS.jsonl`:

- Timestamp, cycle id, agent role, model used
- Full prompt sent to the model
- Full response received
- Every tool call made and its result
- Every git diff produced
- Verification command output
- Final cycle outcome

This is append-only. Users can `grep` their entire bot history. The
opacity that drives Polsia's "I don't know what my bot is doing"
complaints is replaced with full radical transparency by default.

### Hard Rule #10 — Local-first by default

The product runs on the user's machine. Self-hosted cloud
deployment is supported (run the same binary on a user-owned VPS)
but is not the default install path and is not GeneralStaff-the-
company hosted. There is no SaaS tier, no managed offering, no
servers Ray has to keep up.

This is what the original Hard Rule #2 was protecting and is now
codified explicitly so it survives the Rule #2 relaxation.

---

## 4. Open questions resulting from this relaxation

These should be resolved before the relevant build phases start
(see PIVOT-2026-04-15.md for the revised phased plan):

1. **UI framework choice.** Tauri vs. Electron vs. local Bun/Node
   HTTP server. Default lean: Tauri for shipped product (smallest
   binary, no Node runtime baggage); a simple Bun-served browser
   tab is fine during development.

2. **Anthropic ToS clarification.** Before any public messaging
   about "use your own Claude subscription," verify the ToS allows
   headless / programmatic use of subscription quota. Default
   behavior: API-key BYOK in docs; subscription support is opt-in
   personal-use only with a clear note. Do not promise anything
   publicly until the ToS is read.

3. **Plugin API for creative roles.** Marketing/Growth/Support
   plugins need a sandboxed API surface so they cannot escape the
   `creative_work_warning_acknowledged` gate or write outside their
   role's permitted directories. Design pending.

4. **Telemetry policy.** Default is "no telemetry, ever." Optional
   opt-in error reporting (Sentry-style, errors only, no user code,
   no prompts, no diffs) for users who want to help improve the
   project. Never share user code or LLM context.

5. **Distribution channel.** GitHub Releases (binary downloads) +
   Homebrew tap + winget manifest + an optional `npx generalstaff
   init` command. No package manager that requires a Polsia-style
   account.

6. **Verification gate edge cases.** What if the project has no
   tests? What if `verification_command` is intentionally
   `true` (a noop)? Default policy: warn loudly at registration
   time, refuse to enable `auto_merge` for projects with no real
   verification command, allow the cycle but mark it
   `verified_weak` rather than `done`.

---

## 5. Decisions resolved (same day, 2026-04-15)

The 6 open questions in §4 were resolved in the same session that
created this file. Brief decisions; full rationale is in the
conversation transcript and informs the architecture in `DESIGN.md`
v2. These are now locked-in design decisions, not open questions.

### 5.1 UI framework — RESOLVED

**Tauri** for the shipped product; **Bun-served browser tab** for
Phase 4-5 development. Tauri binaries are ~10MB vs. Electron ~150MB,
no Chromium baggage, and the "this is a local app" framing reads
cleaner with a native binary. The Bun browser tab during dev means
no fight with Tauri's build chain while iterating on UI logic.

### 5.2 Anthropic ToS for subscription quota — DEFERRED, default chosen

API-key BYOK (`ANTHROPIC_API_KEY`) is the **only documented blessed
path**. Subscription support exists incidentally because the
`claude` CLI works, but is not promoted in the README. A one-line
note in docs: *"Subscription quota use is at your own discretion —
read Anthropic's ToS."*

**Action item before public release:** read the actual ToS for
headless / programmatic use of subscription quota and decide whether
to block it entirely, allow with disclaimer, or formally support it.

### 5.3 Plugin API for opt-in creative roles — RESOLVED

Plugins are **additional `agent_role` entries in `projects.yaml`**,
not a special plugin runtime. Each creative-role plugin has its own
`hands_off`, its own (possibly weak) `verification_command`, and its
own permission denies. The `creative_work_warning_acknowledged: true`
flag is per-project. A "marketing agent" is mechanically the same as
an "engineer agent" — different prompt template, different tool
permissions, different hands-off — easy to disable, easy to audit,
and uniform with the existing role chain.

### 5.4 Telemetry — RESOLVED

**Zero telemetry by default.** Opt-in error-only Sentry-style
reporting is permitted as a future feature, with the payload
restricted to: stack trace, Claude error code, dispatcher version.
**Never** the prompt, response, diff, file paths, project IDs, or
anything else from the user's project. The default install does not
phone home, and the opt-in is a single toggle in the config file
(no install-time prompt, no dark patterns).

### 5.5 Distribution channel — RESOLVED

**GitHub Releases** is the canonical source of truth (binaries built
in GitHub Actions). **Homebrew tap** for macOS, **winget manifest**
for Windows, **`npx generalstaff init`** for quick start in any
Node-having shell. No `npm publish` to a non-scoped name, no
Polsia-style account requirement. All four secondary channels are
thin pointers to the GitHub Releases artifacts.

### 5.6 Verification gate edge cases — RESOLVED

**Three cycle states** instead of two:

- **`verified`** — verification command passed AND diff is non-empty
  AND reviewer confirmed scope match
- **`verified_weak`** — verification command was empty / `true` /
  no-op, but reviewer agreed the diff matches the task scope
- **`verification_failed`** — anything broken (tests failed, empty
  diff, scope drift, reviewer escalated)

**Auto-merge requires `verified`** — `verified_weak` always escalates
to morning digest regardless of the project's `auto_merge` setting.
The dispatcher logs a loud warning at registration time if a
project's `verification_command` is empty / `true` / a no-op, naming
it explicitly: *"This project has a weak verification command —
auto-merge is not available, every cycle will require manual review."*

This handles the edge case honestly: doesn't refuse projects without
tests outright (which would exclude lots of legitimate small
projects), but doesn't let them auto-merge either.

---

These resolutions update §4 — the "open questions" status above
should be read as "resolved 2026-04-15" for all six.

---

**Signed off:** Ray (interactive session, 2026-04-15)
**Implementing agent:** Claude (Opus 4.6, 1M context)
**Next document:** `PIVOT-2026-04-15.md` (the strategic decision)
**Related design extension:** `DESIGN.md` v2 section appended same day
**Resolved:** §4 open questions resolved later same day in §5 above
