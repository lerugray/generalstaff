# GeneralStaff

![GeneralStaff — the local-first alternative to Polsia. Open Source · BYOK · No SaaS Tax](docs/images/banner.png)

![GeneralStaff Command Center — the dashboard showing current session, attention items, per-project fleet cards, and a preview of live-mode revenue metrics for post-launch projects](docs/images/dashboard-hero.png)

**Open-source autonomous engineering that refuses to ship slop.**
**Your code. Your keys. Your control.**

A meta-dispatcher that runs Claude Code agents on your local projects.
Verification gate you can't prompt around. Hands-off lists per project.
Full audit log of every prompt, response, tool call, and diff in your
own repo. Open-source alternative to closed SaaS bot platforms.

> **Status:** v0.2.0 tagged 2026-05-02 (v0.1.0 was 2026-04-19;
> changelog at [`CHANGELOG.md`](CHANGELOG.md)). **1,989 passing
> tests** across 67 files. Tests doubling as a gate cross-check: a
> cycle only verifies if the suite passes. **30+ managed projects**
> in the fleet (mix of Mode A bot-pickable and Mode B
> interactive-only across the dogfood, game-dev, and mission-*
> ecosystems). Cross-platform (Windows, macOS, Linux); macOS
> dogfood-validated 2026-05-01.
>
> **Subscription auth:** the `claude` provider supports Anthropic
> Pro / Max sessions in addition to API keys, so users on a paid
> Claude plan can run GeneralStaff without separate API spend. BYOK
> remains the default per Hard Rule 8.
>
> **Shipped through launch (Phases 1-7, v0.1.0):** sequential MVP,
> multi-provider LLM routing, cross-project generality, parallel
> worktrees opt-in, visual anchor (terminal dashboards), local web
> dashboard at `generalstaff serve`, pluggable engineer (claude / 
> aider; OpenRouter Qwen 3.6+ Plus cleared 80% on a 10-task
> benchmark), creative-work opt-in, Mode B registrations.
>
> **Shipped in v0.2.0 (2026-04-21..05-02):** usage-budget gate
> (cap sessions on USD / tokens / cycles, reads `ccusage` for real
> spend), Basecamp 4 integration (first-party OAuth2 + read-only
> CLI; opt-in plumbing), AGENTS.md wizard (cross-platform
> agent-config skill at register time), multi-agent orchestration
> tooling (Tier 1/2/3 spawn primitives + inbox-injection routing
> for parallel sessions), `gs welcome` first-run wizard,
> Claude subscription auth (Pro / Max), Mac / Linux session
> launcher, `gs` shim install. Full release notes in
> [`CHANGELOG.md`](CHANGELOG.md).

> **Built by itself.** GeneralStaff is registered as its own first
> managed project. Every verified commit in this repo passed the
> same verification gate, scope-match reviewer, and hands-off check
> the tool ships with. Read
> [`state/generalstaff/PROGRESS.jsonl`](state/generalstaff/PROGRESS.jsonl)
> to count the rejections yourself, including the cycles the system
> caught itself being wrong.

## Contents

- [Built in 4 days](#built-in-4-days)
- [The problem](#the-problem)
- [A different category](#a-different-category)
- [The approach](#the-approach)
- [What it actually catches](#what-it-actually-catches)
- [What it looks like](#what-it-looks-like)
- [Quickstart](#quickstart)
- [Why this over the alternatives](#why-this-over-the-alternatives)
- [Works alongside](#works-alongside)
- [Sister projects](#sister-projects)
- [Opt-in knobs](#opt-in-knobs)
- [Who this is for](#who-this-is-for)
- [The Hammerstein framing](#the-hammerstein-framing)
- [Hard rules](#hard-rules)
- [Roadmap](#roadmap)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [Support](#support)
- [License](#license)

## Built in 4 days

On 2026-04-15 this repo was scaffold + Phase 0 design docs with no
executable code (see `docs/internal/PIVOT-2026-04-15.md` for the day it was
rescoped from "personal nightly dispatcher" to "open-source
alternative to Polsia"). On 2026-04-19 it tagged v0.1.0.

The headline numbers below count engineer-cycle commits, not
human-hours. The tool runs cycles in parallel and overnight; one
human sat at one keyboard, but the dispatcher kept working when the
human stopped. The point of citing them is reproducibility — every
cycle is in `PROGRESS.jsonl` and you can verify the gate fired —
not that a single human typed all of it.

Between those two dates, dogfooding itself the whole time:

- **1,615+ commits**, of which **250+** are shipped task commits
  (one per `gs-XXX` feature or fix landing on master)
- **1,928 passing tests** across 63 test files (of which 4 cover
  the symlink-aware hands-off gate added in the pre-HN audit below)
- **24,500+ lines of TypeScript** in `src/`
- **223 verified + 27 rejected** reviewer verdicts on its own diffs.
  The verification gate caught and rolled back ~10.8% of what the
  engineer proposed, including hands-off violations on
  `src/safety.ts`, `src/reviewer.ts`, and `src/prompts/`.
- 30+ managed projects in the fleet. Mode A (bot-cycling) pilots:
  the dogfood (`generalstaff`), matchmaking-app sandbox (`gamr`),
  second-brain retrieval tool (`raybrain`), Tauri IDE (`devforge`),
  and cross-platform book-search tool (`bookfinder-general`). The
  rest run Mode B as interactive-only registrations: game-dev
  projects, the mission-* ecosystem (mission-bullet,
  mission-employment, mission-housing, mission-PMA), creative work
  where the bot tracks tasks and the human writes diffs, and
  standalone art / research projects (FnordOS, twar-pc,
  greater-than-alexander, veridian-contraption).
- Two pre-launch security audits. The first fixed five
  HIGH/MEDIUM findings. The second caught a symlink bypass on the
  hands-off check plus a handful of low-severity hardening items.
  Both audits landed their fixes in the same pass.

Every cycle in that span wrote a line to
[`state/generalstaff/PROGRESS.jsonl`](state/generalstaff/PROGRESS.jsonl).
`grep '"verdict":"verification_failed"'` it yourself and count the
rejections. The gate is what makes the velocity trustworthy instead
of slop; without it, the commits would be faster and worse.

## The problem

Autonomous coding agents fail in one predictable way: **industrious
without judgment**. Closed SaaS platforms and naive `claude -p` loops
let agents mark tasks as done when tests fail, diffs are empty, or
scope was hallucinated. Polsia's top one-star review complaint on
Trustpilot is false task completions. Nobody is checking the bot's
work against reality, so the damage compounds where you won't see it
until next week.

The pricing model rewards the slop. Closed-SaaS tools charge per
credit whether the project ships or not, so the slop isn't a bug in
their pricing; it's the equilibrium. GeneralStaff refuses to
participate: local-first, BYOK, open audit log, no platform
middleman.

## A different category

Most AI coding tools are co-pilots: a human and an AI taking turns
in a chat window.

GeneralStaff is dispatched labor. You write work orders into
`tasks.json` and read SITREPs when each cycle finishes. Between
those, the dispatcher routes cycles to N parallel agents and runs
each through a Boolean gate before producing a commit.

Three architectural pieces make that work:

- The verification gate runs three checks per cycle: tests pass,
  diff non-empty, reviewer confirms scope match. Cycles that fail
  any check roll back.
- Hands-off lists name the files the bot can't touch. The reviewer
  flags any diff touching those paths, and the cycle rolls back.
- The audit log records every prompt, response, tool call, and
  diff per cycle. You can read it after.

The same architecture runs 30+ projects in flight. Co-pilot UIs
can't because synchronous chat doesn't parallelize.

## The approach

<p align="center">
  <img src="docs/images/cycle-flow.svg"
       alt="The cycle: dispatcher → engineer → verification gate → reviewer → audit log, looped back to dispatcher"
       width="900">
</p>

- **Verification gate** (Hard Rule #6): a Boolean check in the
  dispatcher. Tests must pass, diff must be non-empty, reviewer must
  confirm scope match. A cycle is not marked `done` until all three
  hold. It is code, not a prompt, and it fires on every cycle.
- **Hands-off lists** (Hard Rule #5): per-project glob patterns the
  bot must not touch. The reviewer catches violations and surfaces
  them as true negatives. Empty list = no registration.
- **Worktree isolation:** the bot works in `.bot-worktree` on a
  `bot/work` branch. Your interactive work on `master` never conflicts
  with autonomous cycles, and you review each cycle's diff before
  merging.
- **BYOK billing** (Hard Rule #8): you pay Anthropic, OpenRouter, or
  whoever directly. No platform credits, no SaaS middleman, no revenue
  share.
- **Open audit log** (Hard Rule #9): every prompt, response, tool call,
  and diff in `state/<project>/PROGRESS.jsonl`. Fully reviewable after
  the fact.

Every item above is falsifiable from this repo's own git history. On
2026-04-17 the verification gate caught an autonomous cycle trying to
edit `src/reviewer.ts` (on its own hands-off list) and rejected the
commit. That rejection is in `PROGRESS.jsonl`. Closed SaaS tools can't
show you theirs.

## What it actually catches

The verification gate is not decorative. In this real rejection from
this repo's own audit log, the bot produced a diff modifying three
safety-critical files and the reviewer caught all three:

```json
{
  "event": "reviewer_verdict",
  "cycle_id": "20260417161301_juzs",
  "data": {
    "verdict": "verification_failed",
    "reason": "The diff contains hands-off violations by modifying src/safety.ts and src/reviewer.ts which are explicitly restricted.",
    "hands_off_violations": [
      "src/safety.ts",
      "src/reviewer.ts",
      "src/prompts/"
    ]
  }
}
```

Cycle rolled back. No commit to `master`. The entry above is a
literal line from
[`state/generalstaff/PROGRESS.jsonl`](state/generalstaff/PROGRESS.jsonl).
Grep for `"verdict":"verification_failed"` and count for yourself.
A closed-SaaS tool could not show you this log even if they wanted
to; the log doesn't exist outside their ops.

## What it looks like

The screenshot at the top is the Phase 6 dashboard mockup: a
command-center view with five sections. Current session status, items
that need your attention, per-project fleet cards, dispatch controls,
and a usage sidebar. The dimmed card at the bottom previews how a
post-launch project's card will render once live-mode ingestion lands
(revenue, active users, ad spend, uptime; see
[`docs/internal/UI-VISION-2026-04-19.md`](docs/internal/UI-VISION-2026-04-19.md)).

**What's shipped today:** the data contract. Five JSON view modules
(`fleet-overview`, `task-queue`, `session-tail`, `dispatch-detail`,
`inbox`) and their CLI wrapping. You can run
`generalstaff view fleet-overview --json` right now and get the same
data the dashboard will render. The mockup above lives at
[`web/index.html`](web/index.html) (static HTML, open in any browser).

**What's next:** wrapping the mockup in `Bun.serve` so the dashboard
reads those JSON endpoints live instead of embedded static data. Zero
new dependencies; the view modules already exist.

**Visual direction:** printed paper. Warm cream background, serif
for display, monospace for data, small-caps labels, a single rust
accent used only where something needs your eyes. No SaaS gradients,
no dark-mode-by-default. The earlier Phase 5 visual references (one
reference page per view) live in
[`docs/phase-5-references/`](docs/phase-5-references/).

## Quickstart

### One-line installer (macOS / Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/lerugray/generalstaff/master/install.sh | bash
```

### One-line installer (Windows, PowerShell)

```powershell
irm https://raw.githubusercontent.com/lerugray/generalstaff/master/install.ps1 | iex
```

The installer clones this repo into `./GeneralStaff/`, auto-installs
`bun` if missing (not as root; writes to `$HOME/.bun`), runs
`bun install`, and prints next steps. Safe to re-run. Override the
install location with `GENERALSTAFF_DIR=/your/path`.

### Manual install

Requires `git`, `bash` (on Windows, Git Bash is fine), `bun` 1.2+, and
`claude` (the Claude Code CLI) in your PATH.

```bash
git clone https://github.com/lerugray/generalstaff.git
cd generalstaff
bun install
bun link                                  # makes `generalstaff` a global command
generalstaff doctor                       # verify prerequisites
```

### First-run wizard (recommended for new users)

```bash
gs welcome              # short form, after the one-line installer
generalstaff welcome    # long form, after a manual install
```

A guided ~30-minute briefing for first-time users. It walks you
through provider setup (ollama, openrouter, or claude),
registering your first project, and running one verified cycle so
you can see the dispatcher → engineer → verification → reviewer
loop work end-to-end before you trust it with real tasks.

The provider step detects whether `claude` is on your PATH and
offers a **subscription** path with no API key required. Pro and
Max subscribers don't need to manage a separate Anthropic API
key. The wizard writes a config that spawns `claude -p` directly
and inherits your CLI session. API-key auth is supported as the
second option for users without a subscription. (For openrouter
or ollama, the wizard prompts for the relevant credential or host
URL.)

The substance of every prompt is plain; the staff-officer voice
is flavor only. You can quit at any prompt with Ctrl-C; nothing
irreversible happens until each step's final confirmation.

The wizard composes the existing `bootstrap` + `register` + `cycle`
commands under the hood — once you've used it once, the manual
flow below is straightforward.

### Manual flow (experienced users / scripted setup)

```bash
generalstaff bootstrap /path/to/your-project "what this project is" --id=myproject
# review the .generalstaff-proposal/ output, then move hands_off.yaml into place
generalstaff register myproject --path=/path/to/your-project
generalstaff config                       # pretty-print the parsed config
generalstaff cycle --project=myproject --dry-run
```

Once the dry-run looks right, run a real session:

```bash
generalstaff session --budget=90          # 90-minute cycle budget
generalstaff history --lines=20           # inspect what happened
```

The bot only pushes to `bot/work` on your own remote. Export equals
`git clone`. There is no GeneralStaff server.

### Tested configurations

The full dogfood trail (223 verified cycles, 1,854 passing tests)
ran on **Windows 11 + Claude Code** as the primary engineer. Every
other combination is wired end-to-end and has working test
coverage, but has less real-cycle mileage on it:

- **OS.** macOS and Linux paths exist throughout (shell scripts,
  path resolution, install.sh). The install script smoke-tests
  clean on all three. A 2026-05-01 fresh-Mac dogfood pass
  validated the bootstrap end-to-end (install.sh, `gs welcome`
  through provider setup, full test suite green at 1,850 / 58
  files); three friction items in install.sh + the wizard
  (missing PATH shim, claude-only-API-key assumption,
  free-form model input) shipped fixes the same evening.
  Real-cycle mileage on macOS/Linux is still lighter than on
  Windows; expect rougher edges in less-trodden paths until the
  community shakes them out.
- **Engineer.** `claude -p` is the default. `engineer_provider: aider`
  with OpenRouter (Qwen 3.6+ Plus) cleared 80% verified on a 10-task
  benchmark (`docs/internal/PHASE-7-BENCHMARK-2026-04-20.md`); it's
  production-ready for bulk scaffolding, not yet the default.
- **Reviewer.** OpenRouter and Ollama are first-class; both ship with
  pre-flight reachability checks. Claude as reviewer is the default
  for interactive sessions; OpenRouter for unattended runs to keep
  pressure off the Claude subscription quota.

If you hit a rough edge on a configuration that isn't the Windows +
Claude default, file it at
[github.com/lerugray/generalstaff/issues](https://github.com/lerugray/generalstaff/issues)
with your `generalstaff version` output and the relevant
`PROGRESS.jsonl` lines. The architecture supports the whole matrix;
the shakedown just hasn't been done for every cell of it yet.

## Why this over the alternatives

- **Polsia, Devin, and similar closed SaaS:** your code lives on their
  infra, you pay per-credit, and the platform operator is liable for
  what the bot commits. Failure mode: confident false completions you
  can't audit. GeneralStaff is local-first, BYOK, and the audit log is
  the interface.
- **Naive `claude -p` loops:** rely on prompt engineering to prevent
  hallucination. Prompts can be ignored; Boolean gates cannot. The
  verification gate catches the ~2% tail of cycles where the engineer
  goes stupid+industrious despite its baseline clever-industrious
  tendency.
- **Hand-rolled nightly scripts:** what GeneralStaff started as, and
  what every non-trivial user ends up writing anyway. This is that
  script, generalized, hardened, and made inspectable.

## Works alongside

GeneralStaff is runtime enforcement — it catches the bot at cycle
boundaries with a verification gate, hands-off list, and audit log.
That's defense at the *execution* layer. You can stack it with
instruction-layer tools that make agents behave better *within* each
cycle:

- **[AGENTS.md / agents-md](https://github.com/TheRealSeanDonahoe/agents-md)**
  — one drop-in rules file that teaches every coding agent to
  push back on bad requests, produce minimal diffs, verify before
  claiming done, and compound learned corrections in a
  Section 11 reactive-pruning log. Works inside Claude Code, Codex,
  Cursor, Gemini CLI, Aider, and the rest. Pair it with
  GeneralStaff per-managed-project: agents-md tightens the engineer
  subprocess, the verification gate catches what slips through.

- **[lean-ctx](https://github.com/tzervas/lean-ctx)** — a context
  runtime for coding agents that compresses file reads, shell
  output, and search results into a compact wire format the agent
  can still reason about. It sits underneath Claude Code (or any
  MCP-capable agent) and typically cuts a meaningful fraction of
  the tokens a session would otherwise burn on repeated reads.
  Complementary here: lean-ctx lowers the per-token cost of your
  interactive sessions, which frees weekly quota for the
  autonomous dispatcher to run more cycles before you hit your cap.

- **[aider](https://aider.chat) + OpenRouter** — as of Phase 7,
  projects can set `engineer_provider: aider` (see
  `projects.yaml.example`) to route the engineer half of each
  cycle to aider + OpenRouter (Qwen3 Coder by default) instead of
  the default `claude -p`. Roughly 40× cheaper per token than
  Claude Sonnet and doesn't touch your Claude weekly cap. Best
  suited for bulk scaffolding; complex or algorithmic work should
  stay on the default claude engineer. Full BYOK — you supply your
  own `OPENROUTER_API_KEY`, nothing is hosted on your behalf.

The combination is defense in depth. Use any of them alone if that
fits; none is a hard dependency of the others.

## Sister projects

Three other open-source tools share this repo's posture: your data
on your disk, your keys for paid providers, no SaaS layer. Past
one project, you need three things to keep dispatched labor
useful: voice (output that sounds like you), intent (cycles aimed
at what matters this week), and reaction-testing (catching how a
doc lands before it ships). The three sister apps each fill one
role.

- **[mission-brain](https://github.com/lerugray/mission-brain)**
  gives cycles your voice. Citation-grounded retrieval over your
  writing. Loads markdown notes, Facebook archive, journals, song
  lyrics, or any custom format you write a loader for. Won't emit
  unsourced claims. Voyage cloud or Ollama local. Stack with GS
  so drafts ground in your corpus.
- **[mission-bullet-oss](https://github.com/lerugray/mission-bullet-oss)**
  is your intent layer. AI-assisted bullet journal running Ryder
  Carroll's method: daily capture, weekly review, monthly
  migration. Surfaces themes and proposes migrations without
  touching your raw entries. Stack with GS so cycles work toward
  this week's priorities as you record them.
- **[mission-swarm](https://github.com/lerugray/mission-swarm)**
  is your reaction surface. Swarm-simulation engine that generates
  audience reactions to a document. You define the audience
  templates; it streams reactions round by round. Stack with GS to
  smoke-test feature specs, launch posts, or design docs against a
  synthetic kriegspiel audience before you ship them.

Cycles in any GS-managed project can invoke these as subprocesses,
or talk to mission-brain through its MCP server. Each project
chooses its own integrations. GeneralStaff assumes none by
default.

## Opt-in knobs

Defaults stay conservative on purpose. Autonomous mistakes on other
people's projects cost time to clean up, and most users would rather
pay a bit of friction up front than debug a bad auto-merge later. If
you know what you want, flip any default per-project (or per-task) in
`projects.yaml`. Full schema lives in `projects.yaml.example`. Quick
reference:

| Knob | Effect | Default | Flip when |
|---|---|---|---|
| `engineer_provider: aider` | Route cycles through aider + OpenRouter (Qwen3 / 3.6 Plus) instead of `claude -p` | `claude` | You'd rather not burn Claude subscription quota on bulk scaffolding. Per-cycle OpenRouter cost ~$0.05-0.10. |
| `creative_work_allowed: true` | Allow `creative: true` tasks to dispatch creative-draft cycles (README sections, blog posts, launch copy) with voice references + human-in-the-loop review | `false` | You want bot drafts you can edit, and you've read `docs/internal/RULE-RELAXATION-2026-04-20.md` to understand the guardrails. |
| `auto_merge: true` | Dispatcher auto-merges `bot/work` into your default branch after a clean cycle | `false` (Hard Rule 4 — opt in after 5 clean cycles) | You've watched the bot run cleanly and want to stop merging manually. |
| `dispatcher.session_budget` (also per-project) | Cap a session's consumption in USD, tokens, or cycles. Session stops at the cap. Per-project overrides can add `on_exhausted: skip-project` so one project hitting its cap drops that project from the picker instead of ending the whole session. | unset (no cap) | You want unattended runs without a Claude subscription or OpenRouter credit surprise. |
| `dispatcher.max_parallel_slots: N` | Run N cycles per round in parallel | `1` | You have ≥2 projects with real backlogs and wall-clock is the bottleneck. Multiplies reviewer API spend by N. |
| `task.engineer_provider`, `task.engineer_model` | Per-task engineer override | inherits project | Use `claude` for gnarly refactors, `aider` for scaffold work, picking per task. |
| `task.interactive_only: true` | Mark a task bot-unpickable; you handle it interactively | `false` | Tasks that need your taste / judgment but you still want tracked in the queue. |
| `task.creative: true` | Mark a task as creative (drafts, copy) — routes to creative-work path when enabled project-wide | `false` | Drafts you want the bot to produce for human review. |

The Hard Rules (below) hold regardless of knob state. `projects.yaml`
always requires a non-empty `hands_off` list. `bot/work` is the only
branch the bot pushes to. Every prompt, response, and diff lands in
`PROGRESS.jsonl`. Knobs move the defaults; they can't move those.

## Who this is for

The thesis underneath the whole project is that AI tools should make
work more human, not less. The bot grinds the correctness work —
tests, bugs, scaffolds, small features with clear specs. You keep the
judgment work — what to build, what it should feel like, what the
project is actually for. The line between them is what Hard Rule 1
draws, and why the audit log matters: you can see exactly where the
bot stopped.

GeneralStaff is **neutral on project motivation**. It runs whatever you
point it at -- a commercial SaaS, a research tool, an art project, a
satirical anti-startup, a blog four people read, a fake company that
exists to make a point. The dispatcher has no opinion about what your
project *is*; it runs the correctness work on what you tell it.

Polsia assumes you want to build a profitable SaaS. GeneralStaff
doesn't care what you're building. **Bring your own imagination; the
tool runs the execution.**

This is a deliberate design choice. LLMs asked for "a startup idea"
return the mode of their training distribution, which is generic SaaS.
That is why every Polsia-built company looks the same. GeneralStaff's
answer is that the imagination is yours; the tool is a GM, not a
writer. GMs don't write the players' characters -- they run the rules.

Note that Hard Rule #1 (no creative delegation by default) still
holds. Running a non-SaaS project doesn't mean the bot writes the
satire or the research findings for you. The bot does correctness work
(tests, infra, pipelines, bug grinding); you write the creative part.
The tool is neutral on **motivation**, not on **quadrant**.

## The Hammerstein framing

<p align="center">
  <img src="docs/images/hammerstein-quadrant.svg"
       alt="The Hammerstein typology: Clever/Stupid × Industrious/Lazy. General Staff operates in the Clever+Industrious quadrant; Stupid+Industrious is structurally prevented."
       width="560">
</p>

"GeneralStaff" is borrowed from Kurt von Hammerstein-Equord's officer
typology. The clever-industrious "general staff" handle execution and
dispatch on behalf of command -- they don't make strategy, they make
sure strategy gets executed without dropping the plates.

Hammerstein's warning was specifically about the **stupid+industrious**
quadrant: confident officers without judgment. He argued they must be
dismissed at once because they cause unbounded damage. Autonomous
coding agents without verification gates live in that quadrant.
GeneralStaff's architecture -- verification gate, hands-off lists,
default-off creative roles, open audit log -- structurally prevents
it. The architecture is the philosophy.

The typology's more interesting move is ranking **lazy+clever** above
clever+industrious for strategic command. The staff get the
clever-industrious quadrant because execution rewards diligence paired
with judgment; strategy goes to those who do the minimum work that
produces the right answer, because motion-for-its-own-sake is itself a
failure mode. That ranking is the intellectual backbone of Hard
Rule 1: correctness work (tests, bugs, scope) compounds well under
autonomy because diligence and judgment align; creative work (what
to build, how it should feel) breaks when delegated because judgment,
not motion, is what produces it.

Full writeup of the framing and its empirical backing (5 experiments,
22+ bot runs across Ray's other projects, 7 cited alignment papers)
lives in `docs/internal/`.

## Hard rules

<p align="center">
  <img src="docs/images/hard-rules-grid.svg"
       alt="The ten hard rules of GeneralStaff, as a card grid. Full text in the numbered list below."
       width="960">
</p>

All 10 Hard Rules are enforced either in code or by convention. They
cannot be relaxed without an explicit `RULE-RELAXATION-<date>.md` log
file committed alongside the rule change.

1. **No creative work delegation by default.** Engineering and
   correctness work only. Creative agents are opt-in plugins with
   explicit warnings.
2. **File-based state SSOT.** No databases, no SaaS orchestration.
   A local desktop UI is permitted as a viewer/controller.
3. **Sequential cycles for MVP.** Parallel worktrees come later.
4. **Auto-merge off by default.** Users opt in per-project after 5
   clean verification-passing cycles.
5. **Mandatory hands-off lists.** Empty list = no registration.
6. **Verification gate is load-bearing.** A cycle is not `done` until
   tests pass, diff is non-empty, and reviewer confirms scope match.
7. **Code ownership.** Bot only pushes to `bot/work` on your own git
   remote. Export = `git clone`.
8. **BYOK for LLM providers.** API-key default; subscription support
   is opt-in personal-use only.
9. **Open audit log.** Full prompts, responses, tool calls, and diffs
   in `PROGRESS.jsonl` per cycle.
10. **Local-first.** No SaaS tier, no managed offering, no
    GeneralStaff-the-company hosting.

Details and rationale for each: [`docs/internal/RULE-RELAXATION-2026-04-15.md`](docs/internal/RULE-RELAXATION-2026-04-15.md).

## Roadmap

Phase numbering was re-sequenced when multi-project throughput became
the next bottleneck before the planned UI work. The full narrative for
each closed phase lives in a `PHASE-N-COMPLETE-*.md` doc at the repo
root.

- ✓ **Phase 1** (closed 2026-04-17): sequential MVP, independent
  verification gate, reviewer, open audit log. See
  [`docs/internal/PHASE-1-COMPLETE-2026-04-17.md`](docs/internal/PHASE-1-COMPLETE-2026-04-17.md).
- ✓ **Phase 2** (closed 2026-04-17): multi-provider LLM routing
  (Ollama + OpenRouter + Claude), digest narrative, provider registry.
  See [`docs/internal/PHASE-2-COMPLETE-2026-04-17.md`](docs/internal/PHASE-2-COMPLETE-2026-04-17.md).
- ✓ **Phase 3** (closed 2026-04-18 morning): dispatcher generality
  across non-dogfood projects; `gamr` became the first second managed
  project. Five generality gaps surfaced and catalogued; the
  afternoon closure-tail shipped them same-day. See
  [`docs/internal/PHASE-3-COMPLETE-2026-04-18.md`](docs/internal/PHASE-3-COMPLETE-2026-04-18.md).
- ✓ **Phase 4** (closed 2026-04-18 afternoon): parallel worktrees.
  `pickNextProjects(N)` + round-based Promise.all session loop +
  per-provider reviewer concurrency semaphore + efficiency
  observability in the digest and `status --sessions` table. Default
  `max_parallel_slots: 1` preserves Phase 1-3 behaviour. See
  [`docs/internal/PHASE-4-COMPLETE-2026-04-18.md`](docs/internal/PHASE-4-COMPLETE-2026-04-18.md).
- ✓ **Phase 5 visual anchor** (closed 2026-04-18 evening): five
  hand-built dashboard reference views in
  [`docs/phase-5-references/`](docs/phase-5-references/). Establishes
  palette, type stack, and component vocabulary for the UI shell
  without committing to an implementation stack. One Claude Design
  brief anchored the visual system; four hand-built views extended
  it with zero additional design spend.
- ✓ **Phase 6 local web dashboard** (closed 2026-04-20 afternoon):
  local HTTP server (Bun.serve, port 3737) + `generalstaff serve`
  CLI subcommand + shared layout and stylesheet (foundation trio:
  gs-267/268/269) + four route handlers covering the Phase 5 data
  contract — `GET /project/:id` (gs-283), `GET /cycle/:cycleId`
  (gs-284), `GET /tail/:sessionId` Server-Sent Events stream
  (gs-285), `GET /inbox` (gs-286). Read-only v1 per
  [`docs/internal/PHASE-6-SKETCH-2026-04-19.md`](docs/internal/PHASE-6-SKETCH-2026-04-19.md);
  localhost-bound, no auth beyond 127.0.0.1.
- ✓ **Phase 7 engineer-swap** (closed 2026-04-20): pluggable
  engineer providers via `engineer_provider: claude | aider` on
  ProjectConfig. aider + OpenRouter Qwen3.6-plus cleared the 70%
  verified-rate bar (gs-277 benchmark, 8/10 verified) and shipped
  as the default model. Creative-work opt-in (gs-278 Phase A +
  gs-279 Phase B) carved out the first exception to Hard Rule #1
  — per-project `creative_work_allowed: true`, per-task
  `creative: true`, branch routing to `bot/creative-drafts`,
  reviewer skip, voice-reference prompt prepend. First real-world
  creative cycle (bookfinder-general's bf-005) drafted a
  usable-with-light-edit README section now live on public main.
  See [`docs/internal/PHASE-7-BENCHMARK-2026-04-20.md`](docs/internal/PHASE-7-BENCHMARK-2026-04-20.md).
- ✓ **Usage-budget gate** (shipped in v0.2.0, closed 2026-04-21):
  session-level consumption cap wired into the dispatcher loop.
  Fleet-wide and per-project `session_budget` config with
  exactly-one-unit validation (max_usd / max_tokens / max_cycles),
  hard-stop and advisory enforcement modes, and a `skip-project`
  option on per-project caps so one project exhausting its share
  drops off the picker without ending the session. Reads Claude
  Code's own 5-hour session blocks via the `ccusage` library, so
  the gate reflects real spend rather than a pre-cycle estimate.
  Design in
  [`docs/internal/USAGE-BUDGET-DESIGN-2026-04-21.md`](docs/internal/USAGE-BUDGET-DESIGN-2026-04-21.md).
- ✓ **Basecamp 4 integration** (shipped in v0.2.0, closed
  2026-04-21): first-party OAuth2 setup helper, thin TypeScript
  client, and
  `generalstaff integrations basecamp auth | whoami | projects`
  CLI subcommands. Optional plumbing; the dispatcher itself does
  not depend on Basecamp. A GS-managed project can pull Basecamp
  state into its own cycle prompts. Docs in
  [`docs/integrations/basecamp.md`](docs/integrations/basecamp.md).
- ✓ **AGENTS.md wizard, Phase A** (shipped in v0.2.0, closed
  2026-04-25): a Claude Code skill at
  `.claude/skills/agents-md-wizard/` that runs a conversational
  discovery wizard producing an AGENTS.md at the project root.
  Type-branched question sets (heavy 8-12 questions for business
  / game / research / infra projects; lightweight 2-3 for
  side-hustle / personal-tool / nonsense; skip for no-plan-needed).
  Wired into `generalstaff register` with a skip-by-default prompt;
  standalone via `generalstaff plan <project>`. AGENTS.md is the
  cross-platform agent-config standard adopted by Claude Code,
  Cursor, Aider, Codex, Zed, and the rest, so the artifact gives
  free integration with whatever other AI tool you use. Phase B
  (reviewer alignment check) and Phase C (drift detection) follow.
- ✓ **Multi-agent orchestration tooling** (shipped in v0.2.0,
  closed 2026-04-25): scripts at
  [`scripts/orchestration/`](scripts/orchestration/) for spawning,
  monitoring, and routing work across parallel Claude Code
  sessions. Four tiers in increasing weight: in-process `Agent`
  subagents, opt-in Agent Teams (inter-agent messaging), Tier 2
  background `claude -p` spawns for bounded one-shot side-quests,
  Tier 3 detached visible cmd windows for work that must outlive
  the primary session. Inbox-injection hook (v4) routes messages
  between sessions via a shared outbox without shared state. Used
  in dogfood for parallel feature sprints across managed projects.
- ✓ **`gs welcome` first-run wizard, Claude subscription auth,
  Mac/Linux session launcher, `gs` shim install** (shipped in
  v0.2.0): see [`CHANGELOG.md`](CHANGELOG.md) for full per-feature
  notes.
### Recently shipped (post-v0.2.0)

- ✓ **Phased autonomous progression — Phases A, B, and B+**
  (shipped across 2026-05-03 / 2026-05-04). Projects declare a
  phased campaign in `state/<project>/ROADMAP.yaml`: per-phase
  goals, completion criteria, and literal tasks seeded when the
  phase advances. The dispatcher detects ready phases at session
  start (writes a PHASE_READY.json sentinel + emits a
  `phase_ready_for_advance` event); the commander runs
  `generalstaff phase advance` to transition. `gs view phase-ready`
  lists awaiting projects from the CLI; the dashboard at
  `/phase` (under `gs serve`) renders the same data with an
  in-page Advance form button per row. Phase B+ added opt-in
  auto-advance (`auto_advance: true` flag), multi-phase rollback
  (`gs phase rollback --to=<phase>`), `tasks_template:` with
  `{phase_id}` / `{prev_phase}` / `{project_id}` / `{date}` /
  `{datetime}` placeholders, and two previously-deferred completion
  criteria: `launch_gate: "<gate-id>"` (reads checkbox state from
  `LAUNCH-PLAN.md`) and `git_tag: "<tag>"` (passes when the named
  tag exists in the project's repo). Of the original five
  criterion kinds, only `lifecycle_transition` remains
  not-yet-evaluated. Schema reference in
  [`docs/conventions/roadmap.md`](docs/conventions/roadmap.md);
  original design at
  [`docs/internal/FUTURE-DIRECTIONS-2026-04-19.md`](docs/internal/FUTURE-DIRECTIONS-2026-04-19.md).
- ✓ **Session-complete notification — threshold tag + per-project
  breakdown** (gs-303, 2026-05-04). End-of-session Telegram
  message uses `[OK]` / `[PARTIAL]` / `[FAIL]` based on the
  verified-vs-failed ratio (>=75% / 25-74% / <25%) instead of
  fail-on-any-cycle. Header gains a `Touched: project (N), ...`
  line; bullets in "What got done" group by project with
  `[project-id]` prefix. Reads cleanly at a glance whether a
  multi-project session moved real work.
- ✓ **Parallel-picker work-detection — GS-root fallback**
  (gs-304, 2026-05-04). `greenfieldHasMoreWork` /
  `greenfieldCountRemaining` / `greenfieldCountRemainingDetailed`
  now fall back from `<projectPath>/state/<id>/tasks.json` to
  `<getRootDir()>/state/<id>/tasks.json` when the per-project
  file is missing. Removes the load-bearing per-machine symlink
  workaround for parallel-mode pickers; legacy gamr/raybrain-
  style projects (state in their own repo) keep working
  unchanged.
- ✓ **Usage-budget integration test coverage closed**
  (gs-301a..e, 2026-05-04). The full 11-scenario test matrix
  from [`docs/internal/USAGE-BUDGET-DESIGN-2026-04-21.md`](docs/internal/USAGE-BUDGET-DESIGN-2026-04-21.md)
  shipped across five atomic commits. Covers the three budget
  axes (max_usd, max_tokens, max_cycles), both enforcement modes
  (hard / advisory), per-project vs fleet-cap semantics, the
  validation rejection path, and the 5-hour-window math.
  Subprocess-isolation pattern keeps `mock.module` calls sandboxed
  per scenario. Originally a single `gs-301` task that lost 7 bot
  attempts at the 400-700 LOC monolith; splitting into five
  ~120-180 LOC atomic tasks let each scenario land in a focused
  cycle.

### Proposed (not yet scheduled)

- **UI actions on top of the read-only dashboard.** Dispatch
  sessions from the dashboard, edit `tasks.json` from the UI,
  merge `bot/work` with a button. The phase advance button
  shipped 2026-05-04 is the first write-mode action; broader
  write-mode is the next iteration.
- **Non-programmer-friendly UI/UX path.** The CLI stays the
  recommended primary surface for users comfortable with a
  terminal. A guided flow for users who'd rather not live in
  `bash`: register projects, queue tasks, and watch cycles run
  from a desktop app or web UI. Scoped for users who can describe
  a project in plain English but don't want to write `tasks.json`
  by hand. The visual register inherits from the Phase 5
  references; the Phase 6.5+ work defines the interaction model.
- **Command-room UI aesthetic.** Kriegspiel-inspired
  high-density map/status layout, borrowed from 19th-century
  Prussian wargaming. See
  [`docs/internal/UI-VISION-2026-04-15.md`](docs/internal/UI-VISION-2026-04-15.md).

## Documentation

- [`DESIGN.md`](DESIGN.md) -- full architecture sketch (v1 through
  v6, append-only; v6 = Phase 4 parallel worktrees)
- [`docs/internal/PIVOT-2026-04-15.md`](docs/internal/PIVOT-2026-04-15.md) -- the open-source
  pivot decision and original 12-phase plan
- [`docs/internal/PHASE-1-PLAN-2026-04-15.md`](docs/internal/PHASE-1-PLAN-2026-04-15.md) -- the
  Phase 1 plan that shipped
- [`docs/internal/PHASE-4-COMPLETE-2026-04-18.md`](docs/internal/PHASE-4-COMPLETE-2026-04-18.md)
  -- parallel worktrees closure narrative, including the three
  design-decision resolutions and the gs-188 observability surface
- [`projects.yaml.example`](projects.yaml.example) -- config schema
  reference, including the `max_parallel_slots` opt-in
- [`docs/integrations/basecamp.md`](docs/integrations/basecamp.md) --
  Basecamp 4 integration setup, auth flow, CLI reference, and
  gotchas (pagination, User-Agent, token lifecycle)
- [`docs/conventions/usage-budget.md`](docs/conventions/usage-budget.md) --
  `dispatcher.session_budget` config surface (USD / tokens / cycles),
  hard-stop vs advisory enforcement, provider reader landscape, and
  how the Claude Code 5-hour rolling window interacts with the cap
- [`docs/phase-5-references/`](docs/phase-5-references/) -- Phase 5
  UI reference views (fleet, queue, tail, detail, inbox) with a
  README documenting what each establishes and how the vocabulary
  carries across views
- [`CLAUDE.md`](CLAUDE.md) -- instructions for Claude Code sessions
  operating in this repo
- [`AGENTS.md`](AGENTS.md) -- cross-platform agent-config artifact
  produced by the AGENTS.md wizard (gs-322 dogfood); read by Claude
  Code, Cursor, Aider, Codex, Zed, and other AGENTS.md-aware agents
- [`scripts/orchestration/README.md`](scripts/orchestration/README.md)
  -- four-tier orchestration tooling for parallel Claude Code
  sessions, including the inbox-injection routing hook
- [`docs/internal/research-notes.md`](docs/internal/research-notes.md) -- research on prior art
  (nightcrawler, parallel-cc, Polsia, Continuous-Claude-v3)

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the short version: correctness
PRs are welcome, taste-work PRs need a conversation first (Hard Rule 1
applies to contributors too), and the best bug report is a snippet of
your own `PROGRESS.jsonl` showing the cycle that failed.

## Support

GeneralStaff is maintained by one person alongside a minimum-wage day
job. Per Hard Rule 10, there is no company layer. Support goes to the
maintainer directly through
[GitHub Sponsors](https://github.com/sponsors/lerugray). See
[`SUPPORTERS.md`](SUPPORTERS.md).

## License

[AGPL-3.0-or-later](LICENSE). Running GeneralStaff as a hosted service
requires offering the corresponding source to users of that service —
the license is chosen deliberately to prevent the SaaS-fork attack
the project positions against.
