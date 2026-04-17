# GeneralStaff

**Open-source autonomous engineering for solo founders.**
**Your code. Your keys. Your control.**

A meta-dispatcher that runs Claude Code agents on your local projects
with a verification gate that cannot be prompted around, mandatory
hands-off lists, and a full audit log of every prompt, response, and
diff. The principled alternative to closed-source SaaS bot platforms.

> **Status (2026-04-16):** Phase 1 shipped. 23 source modules, 353
> passing tests, 15 CLI commands. Dogfooded across 40+ autonomous
> cycles with zero false positives from the verification gate. Private
> repo, preparing for public launch. Ships cross-platform (Windows,
> macOS, Linux).

## The problem

Autonomous coding agents fail in one predictable way: they are
**industrious without judgment**. Closed SaaS platforms and naive
`claude -p` loops let agents confidently mark tasks as done when tests
fail, diffs are empty, or scope was hallucinated. Polsia's #1 one-star
review complaint on Trustpilot is false task completions. The damage
compounds quietly because nobody is checking the bot's work against
reality.

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
default-off creative roles, open audit log -- structurally prevents it.
The architecture is the philosophy.

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

- **Phase 2:** Multi-provider LLM routing (`provider_config.yaml`).
  Reviewer already runs on OpenRouter Qwen by default (validated 4/4
  verdict agreement with Claude on sample cycles); engineer routing
  and Ollama-tier summarization are next. See
  [`FUTURE-DIRECTIONS-2026-04-15.md`](FUTURE-DIRECTIONS-2026-04-15.md) §2.
- **Phase 3:** Add a second managed project (structurally different
  from the dogfood) to stress-test the abstractions.
- **Phase 4:** Local desktop UI shell (Tauri) for control and audit.
- **Phase 5.5+:** Kriegspiel / command-room UI theme. See
  [`UI-VISION-2026-04-15.md`](UI-VISION-2026-04-15.md).
- **Phase 7:** Public launch. You are here, approximately.

## Documentation

- [`DESIGN.md`](DESIGN.md) -- full architecture sketch (v1 + v2,
  append-only)
- [`PIVOT-2026-04-15.md`](PIVOT-2026-04-15.md) -- the open-source
  pivot decision and 12-phase plan
- [`PHASE-1-PLAN-2026-04-15.md`](PHASE-1-PLAN-2026-04-15.md) -- the
  plan that shipped
- [`projects.yaml.example`](projects.yaml.example) -- config schema
  reference
- [`CLAUDE.md`](CLAUDE.md) -- instructions for Claude Code sessions
  operating in this repo
- [`research-notes.md`](research-notes.md) -- research on prior art
  (nightcrawler, parallel-cc, Polsia, Continuous-Claude-v3)

## Contributing

Pre-public; issues and PRs welcome once the repo goes public. Until
then, the fastest way to give feedback is via the audit log of a
session you ran yourself -- `PROGRESS.jsonl` is designed to be
diff-friendly so you can show exactly what broke.

License: MIT.
