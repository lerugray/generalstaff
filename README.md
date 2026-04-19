# GeneralStaff

**Open-source autonomous engineering that refuses to ship slop.**
**Your code. Your keys. Your control.**

A meta-dispatcher that runs Claude Code agents on your local projects
with a verification gate that cannot be prompted around, mandatory
hands-off lists, and a full audit log of every prompt, response, and
diff. The principled alternative to closed-source SaaS bot platforms.

> **Status.** Phases 1–4 shipped: sequential MVP, multi-provider LLM
> routing, cross-project generality, opt-in parallel worktrees.
> Phase 5 visual anchor closed; UI shell in progress. Over 1,000
> passing tests; three managed projects cycling. Private repo,
> preparing for public launch. Ships cross-platform (Windows,
> macOS, Linux).

> **Built by itself.** GeneralStaff is registered as its own first
> managed project. Every verified commit in this repo passed the
> same verification gate, scope-match reviewer, and hands-off check
> the tool ships with. Read
> [`state/generalstaff/PROGRESS.jsonl`](state/generalstaff/PROGRESS.jsonl)
> to count the rejections yourself — including the cycles the system
> caught itself being wrong.

## The problem

Autonomous coding agents fail in one predictable way: they are
**industrious without judgment**. Closed SaaS platforms and naive
`claude -p` loops let agents confidently mark tasks as done when tests
fail, diffs are empty, or scope was hallucinated. Polsia's #1 one-star
review complaint on Trustpilot is false task completions. The damage
compounds quietly because nobody is checking the bot's work against
reality.

The economic shape compounds the technical failure. Closed-SaaS tools
charge per credit for confident slop and capture the value whether
the project ships or not. The slop isn't a bug in the pricing model;
it's what the pricing model rewards — the tool wins whether your
project works or not. GeneralStaff is structured to refuse
participation in that equilibrium: local-first, BYOK, open audit log,
no platform middleman.

## The approach

```
 dispatcher --> engineer --> verification gate --> reviewer --> audit log
    (picks)    (codes)     (tests must pass)    (scope match)   (open)
```

- **Verification gate** (Hard Rule #6): a Boolean check in the
  dispatcher. Tests must pass, diff must be non-empty, reviewer must
  confirm scope match. A cycle is not marked `done` until all three
  hold. This is not a prompt -- it is code, and it fires on every cycle.
- **Hands-off lists** (Hard Rule #5): per-project glob patterns that
  the bot must not touch. Violations are caught by the reviewer and
  surfaced as true negatives. Empty list = no registration.
- **Worktree isolation**: the bot works in `.bot-worktree` on a
  `bot/work` branch. Your interactive work on `master` never conflicts
  with autonomous cycles, and you can review any cycle's diff before
  merging.
- **BYOK billing** (Hard Rule #8): you pay Anthropic, OpenRouter, or
  whoever directly. No platform credits, no SaaS middleman, no revenue
  share.
- **Open audit log** (Hard Rule #9): every prompt, response, tool call,
  and diff in `state/<project>/PROGRESS.jsonl`. Fully reviewable after
  the fact.

Every item above is falsifiable from this repo's own git history. On
2026-04-17 the verification gate caught an autonomous cycle trying to
edit `src/reviewer.ts` — a file on its own hands-off list — and
rejected the commit. That rejection is in `PROGRESS.jsonl`. Closed
SaaS tools can't show you theirs.

## What it looks like

Phase 5 ships a local dashboard with five linked views: a fleet
overview showing every registered project's state at a glance, a
per-project task queue, a live session log, per-cycle detail pages
for drilling in when something needs attention, and a shared-inbox
channel for cross-session handoff notes.

The visual direction is printed-paper. Warm cream background, serif
for display, monospace for data, small-caps labels, a rust accent
used only where something needs your eyes. No SaaS gradients, no
dark-mode-by-default. Reference HTML for each view lives in
[`docs/phase-5-references/`](docs/phase-5-references/), along with a
README documenting what each view establishes and which patterns
carry across them.

## Quickstart

Requires `git`, `bash` (on Windows, Git Bash is fine), `bun` 1.2+, and
`claude` (the Claude Code CLI) in your PATH.

```bash
git clone https://github.com/lerugray/generalstaff.git
cd generalstaff
bun install
bun link                                  # makes `generalstaff` a global command
generalstaff doctor                       # verify prerequisites
```

Point it at a project you want the bot to work on:

```bash
generalstaff init /path/to/your-project --id=myproject
# edit projects.yaml -- set engineer_command, verification_command,
# cycle_budget_minutes, and hands_off patterns for the project
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
lives in the internal docs; see `docs/internal/` once the repo is
public.

## Hard rules

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

Details and rationale for each: [`RULE-RELAXATION-2026-04-15.md`](RULE-RELAXATION-2026-04-15.md).

## Roadmap

Phase numbering was re-sequenced when multi-project throughput became
the next bottleneck before the planned UI work. The full narrative for
each closed phase lives in a `PHASE-N-COMPLETE-*.md` doc at the repo
root.

- ✓ **Phase 1** (closed 2026-04-17): sequential MVP, independent
  verification gate, reviewer, open audit log. See
  [`PHASE-1-COMPLETE-2026-04-17.md`](PHASE-1-COMPLETE-2026-04-17.md).
- ✓ **Phase 2** (closed 2026-04-17): multi-provider LLM routing
  (Ollama + OpenRouter + Claude), digest narrative, provider registry.
  See [`PHASE-2-COMPLETE-2026-04-17.md`](PHASE-2-COMPLETE-2026-04-17.md).
- ✓ **Phase 3** (closed 2026-04-18 morning): dispatcher generality
  across non-dogfood projects; `gamr` became the first second managed
  project. Five generality gaps surfaced and catalogued; the
  afternoon closure-tail shipped them same-day. See
  [`PHASE-3-COMPLETE-2026-04-18.md`](PHASE-3-COMPLETE-2026-04-18.md).
- ✓ **Phase 4** (closed 2026-04-18 afternoon): parallel worktrees.
  `pickNextProjects(N)` + round-based Promise.all session loop +
  per-provider reviewer concurrency semaphore + efficiency
  observability in the digest and `status --sessions` table. Default
  `max_parallel_slots: 1` preserves Phase 1-3 behaviour. See
  [`PHASE-4-COMPLETE-2026-04-18.md`](PHASE-4-COMPLETE-2026-04-18.md).
- ✓ **Phase 5 visual anchor** (closed 2026-04-18 evening): five
  hand-built dashboard reference views in
  [`docs/phase-5-references/`](docs/phase-5-references/). Establishes
  palette, type stack, and component vocabulary for the UI shell
  without committing to an implementation stack. One Claude Design
  brief anchored the visual system; four hand-built views extended
  it with zero additional design spend.
- **Phase 5 UI shell** (in progress): local dashboard implementation
  reading the Phase 5 data contract (`src/views/*.ts`). Implementation
  stack (Tauri, local web server, or other) not yet chosen. Data to
  render (gs-188's parallel-efficiency metrics) is already live.
- **Phase 5.5+:** Kriegspiel / command-room UI theme. See
  [`UI-VISION-2026-04-15.md`](UI-VISION-2026-04-15.md).
- **Public launch:** gated on README polish, `SUPPORTERS.md`, and
  `LICENSE` — not on Phase 5 completion per
  [`LAUNCH-PLAN.md`](LAUNCH-PLAN.md). The CLI surface is feature-
  complete for the MVP value proposition; the UI is an enhancement.

## Documentation

- [`DESIGN.md`](DESIGN.md) -- full architecture sketch (v1 through
  v6, append-only; v6 = Phase 4 parallel worktrees)
- [`PIVOT-2026-04-15.md`](PIVOT-2026-04-15.md) -- the open-source
  pivot decision and original 12-phase plan
- [`PHASE-1-PLAN-2026-04-15.md`](PHASE-1-PLAN-2026-04-15.md) -- the
  Phase 1 plan that shipped
- [`PHASE-4-COMPLETE-2026-04-18.md`](PHASE-4-COMPLETE-2026-04-18.md)
  -- parallel worktrees closure narrative, including the three
  design-decision resolutions and the gs-188 observability surface
- [`LAUNCH-PLAN.md`](LAUNCH-PLAN.md) -- pre-launch gates, positioning,
  narrative hooks, and the append-only launch retrospective
- [`projects.yaml.example`](projects.yaml.example) -- config schema
  reference, including the `max_parallel_slots` opt-in
- [`docs/phase-5-references/`](docs/phase-5-references/) -- Phase 5
  UI reference views (fleet, queue, tail, detail, inbox) with a
  README documenting what each establishes and how the vocabulary
  carries across views
- [`CLAUDE.md`](CLAUDE.md) -- instructions for Claude Code sessions
  operating in this repo
- [`research-notes.md`](research-notes.md) -- research on prior art
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
