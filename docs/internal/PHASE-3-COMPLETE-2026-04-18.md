# Phase 3 — Complete (2026-04-18)

**Closed:** 2026-04-18
**Elapsed from Phase 2 close:** ~17 hours (2026-04-17T18:41 → 2026-04-18T11:35 UTC)
**Elapsed from Phase 0 start:** ~70 hours (2026-04-15 evening → 2026-04-18 morning)

## Summary

Phase 3 per PIVOT-2026-04-15.md §"Phased build plan" =
**dispatcher generality — surfacing and closing gaps that only
appear on non-dogfood projects.** Closure criterion per gs-174:
*three consecutive verified gamr cycles without dispatcher-level
changes between them.*

Closure achieved: **3/3 verified gamr cycles**, all on first
attempt, OpenRouter reviewer, zero rollbacks.

The Phase's strategic value is not the cycles themselves —
they're trivial scaffolding work — but the **five generality gaps
surfaced and catalogued** during the work that gets to closure.
gamr was deliberately mediocre; the goal was to hold product
quality constant-and-low so dispatcher behavior was the only
dependent variable. That experimental design worked: every gap
catalogued is invisible on dogfood and lands on a fresh
non-dogfood project the moment it shows up.

## What shipped

### Tasks landed (this Phase 3 window: 2026-04-17 evening → 2026-04-18 morning)

| Task | File(s) | Purpose |
|------|---------|---------|
| gs-166 | `src/work_detection.ts` | Greenfield work detection reads from `project.path` (not `getRootDir()`) |
| gs-167 | `src/bootstrap.ts` | Bootstrap writes `tasks.json` to project state dir (project repo, not GS root) |
| gs-168 | `tests/cycle.test.ts` | Integration test: full non-dogfood cycle (gs-166 regression guard) |
| gs-169 | `tests/bootstrap.test.ts` | `runBootstrap` force-path edge case |
| gs-170 | `src/cli.ts`, `src/register.ts` | `generalstaff register <id>` CLI subcommand |
| gs-171 | `src/reviewer.ts`, `tests/reviewer.test.ts` | Hardened JSON parser against false-negative rollback (10 cycles in 24h saved) |
| gs-172 | `src/prompts/reviewer.ts`, `tests/reviewer_prompt.test.ts` | Belt-and-braces: prompt forbids unescaped-inner-colon pattern + asks for bare task IDs |
| gs-173 | `projects.yaml`, `gamr/state/gamr/*`, `gamr/engineer_command.sh` | Registered gamr as first non-dogfood managed project |
| gs-174 | (process task — 3 verified cycles) | First gamr cycles + Phase 3 closure criterion |

gs-166 through gs-170 landed via the overnight bot run (2026-04-18
00:20–01:22 UTC, 5 verified cycles). gs-171 through gs-173 ran
interactively because each task touched a hands-off file
(`src/reviewer.ts`, `src/prompts/`, `projects.yaml` respectively
— see "Generality gaps surfaced" below).

### Generality gaps surfaced and queued

**gs-175 (P1) — register CLI state-path drift.** `src/register.ts`
reads `${getRootDir()}/state/<id>/tasks.json` (GS root)
inconsistent with `src/work_detection.ts` post-gs-166 which reads
`${project.path}/state/<id>/tasks.json` (target repo). Dogfood
masks the divergence; gamr exposed it the first attempt. Caused
us to bypass the CLI for gs-173 today.

**gs-176 (P1) — bootstrap engineer_command.sh template gap.**
`src/bootstrap.ts` generates `engineer_command.sh` containing
just `claude -p --dangerously-skip-permissions` — no prompt, no
worktree management. Bot would silently fail or clobber the main
working tree on first cycle. Today's gamr scaffold patched
manually; the patched file is the next bootstrap template.

**gs-177 (P1) — `auto_merge=false` chained-cycles ceiling.** With
auto_merge=false (default per Hard Rule #4), the dispatcher
correctly refuses to start cycle N+1 because resetting bot/work
would destroy cycle N's unmerged work. This caps every project
at one cycle per session AND creates a chicken-and-egg with Hard
Rule #4 (5 cycles before opt-in, but 1 cycle per session). Three
candidate dispatcher behaviors documented in the task body.

**gs-178 (P1) — audit-log writes dirty the GS tree mid-session.**
`audit.ts:21` writes `state/<id>/PROGRESS.jsonl` into GS's
tracked tree. The next cycle's clean-tree safety check refuses to
run any project (including the project that wasn't even being
audited). Cross-project chaining structurally blocked within a
session until those PROGRESS.jsonl writes get committed.

**Implicit (deferred) — task picker has no defined tiebreak.** The
bot's within-project task picker reads `tasks.json` and picks
"the highest-priority unfinished task" with no defined tiebreak
between same-priority entries. Worked around today by
temporarily demoting gs-173 from P1 to P2 so gs-171 was uniquely
P1; restored after gs-171 landed. Structural fix (e.g. `bot_safe`
flag + ID-order tiebreak) deferred — Ray and I agreed to leave
for after gamr-cycle test run.

## Quantitative evidence

| Metric | Value |
| --- | --- |
| Phase window | 2026-04-17T20:20 → 2026-04-18T11:35 UTC (~15h wall, mostly idle) |
| Tasks landed | 9 (gs-166..170 overnight; gs-171..174 interactive arc) |
| Generality gaps catalogued | 5 (gs-175..178 + implicit picker-tiebreak) |
| gamr verified cycles | 3 (gamr-001 sanity, gamr-002 layout, gamr-003 page) |
| gamr rolled-back cycles | 0 |
| Average gamr cycle duration | 96s wall (103s, 106s, ~80s) |
| OpenRouter reviewer rollbacks (post-gs-171) | 0 |
| Hands-off violations attempted | 1 (gs-171 attempt by bot — correctly caught) |
| Hands-off violations leaked to master | 0 |

## Definition-of-done check

Against PIVOT-2026-04-15.md §"Phased build plan" for Phase 3:

- ✅ **First non-dogfood managed project registered.** gamr at
  `C:/Users/rweis/OneDrive/Documents/gamr/`, state at
  `gamr/state/gamr/`, projects.yaml updated.
- ✅ **Dispatcher generality test executed.** 3 verified cycles
  end-to-end with no dispatcher code changes between them.
- ✅ **Generality gaps catalogued, not patched inline.** Per
  gs-174's instruction: "queue follow-up tasks rather than
  patching inline." 5 gaps queued (gs-175..178 + picker
  tiebreak), zero in-flight patches.
- ✅ **gs-171 (verification-gate parser hardening) lands.** 967
  tests pass post-merge; `parseReviewerResponse` now bifurcates
  decision-critical (strict) vs observational (permissive) per
  DESIGN.md §v4. Validated against the archived failing-fixture
  cycles (`20260417011019_86ct`, `20260418005225_tzrd`).
- ⚠️ **3 consecutive verified cycles "without dispatcher-level
  changes between them"** — met *literally* (no dispatcher source
  code changed between cycles), but **operationally** the manual
  merge + state housekeeping between each pair of cycles was
  load-bearing. gs-177 and gs-178 close that gap; until they do,
  Phase 3 closure is fragile to "run two cycles in a row without
  human intervention."

## Failure analysis

### gs-171 first attempt (bot, rolled back correctly)

The 2026-04-18 morning bot session attempted gs-171 and produced
a high-quality 393-insertion implementation with 7 fixture-driven
regression tests. The verification gate correctly rolled it back:
`src/reviewer.ts` is in the hands-off list precisely because
letting an autonomous agent modify its own oversight would invite
motivated reasoning. The gate did its job. We applied the bot's
diff verbatim from the archived `cycles/20260418105355_9r5h/diff.patch`
in the interactive session — bot did the engineering, human did
the privileged write.

This is the cleanest possible illustration of the
"bot-vs-interactive" boundary: the bot can _propose_ changes to
safety-critical files (and apparently propose well), but the
final write requires interactive judgment. Worth keeping that
boundary load-bearing rather than papering over it with bot-level
exceptions.

### Reviewer (OpenRouter Qwen) rollbacks: zero post-gs-171

Across the three gamr verified cycles, every reviewer response
parsed cleanly (response sizes 578, 610, ~580 bytes — small,
well-formed). **Cannot tell from this sample alone** whether
gs-171's permissive path was triggered or whether Qwen happened
to produce well-formed JSON — both would look identical at the
gate. A definitive measurement would need a longer sample with
known-bad inputs in the wild. The 24-hour pre-fix rate was
~10/100 cycles (10%); a comparable 100-cycle post-fix sample
would give a real falsification or confirmation.

## Known gaps (for future interactive sessions)

All five gaps from "Generality gaps surfaced" above are P1 and
queued for tomorrow / next batch:

- **gs-175** — register CLI state-path fix (interactive: register.ts
  is not hands-off, but the test fixture for non-dogfood paths
  is a good interactive task)
- **gs-176** — bootstrap engineer_command.sh template fix
  (interactive: bootstrap.ts is not hands-off either, but the
  template-generation logic is small and benefits from a careful
  human pass)
- **gs-177** — auto_merge / chained cycles dispatcher behavior
  (interactive design decision before code: the three candidate
  behaviors all have real tradeoffs against Hard Rule #4)
- **gs-178** — audit-log clean-tree exemption (mostly bot-safe
  modulo the scope of the safety check itself; should be
  reviewable as a small focused change)
- **(implicit) picker tiebreak** — only worth structural fix when
  the bot regularly hits same-priority pairs; not urgent

## Next phase

Per PIVOT-2026-04-15.md §"Phased build plan" the next phase
focuses on the architectural cleanups gs-175..178 represent.
Whether to call that "Phase 4" formally or treat it as Phase 3
post-closure consolidation is open — the Hard Rules and
verification gate are unchanged, so calling it a fresh phase may
overweight the importance of internal cleanups. Suggest leaving
the phase taxonomy alone and treating gs-175..178 as part of
Phase 3's closure tail rather than a new phase opening.

The cumulative architectural arc remains: Phase 1 = sequential
MVP that works on dogfood. Phase 2 = multi-provider routing
without breaking dogfood. Phase 3 = generalize cleanly to
non-dogfood. Whatever comes next is "harden Phase 3" — likely
Phase 4 = parallel worktrees, Phase 5 = local UI per the original
PIVOT plan.

## Closure-tail addendum (2026-04-18 morning)

All four catalogued P1 generality gaps from "Generality gaps
surfaced" above shipped same day, by 2026-04-18T12:24 UTC:

| Gap | Mechanism | Validation |
|---|---|---|
| gs-175 register CLI state-path drift | bot session 6 cycle 1 (auto, OpenRouter reviewer) | reviewer cited "task gs-175" using the gs-172 bare-ID convention |
| gs-176 bootstrap engineer_command template | bot session 6 cycle 2 (auto, chained via gs-177's merge-then-reset path) | gamr's manually-patched scaffold became the new template; verified by tests |
| gs-177 auto_merge=false accumulator | interactive — DESIGN.md §v5 design discussion first, then code | session 5 ran 5 gamr cycles (2 substantive + 3 empty-drained) chained without a single human merge |
| gs-178 audit-tree dirty-check exemption | interactive — narrow whitelist for state/<id>/PROGRESS.jsonl | session 6's 5 cycles each appended to PROGRESS.jsonl without blocking the next cycle's preflight |

**The "minimal human interaction" milestone.** Pre-2026-04-18,
the bot could do exactly one cycle per project per session
under the default `auto_merge=false`, requiring a human merge
between every cycle. By 2026-04-18T12:24 UTC, both halves of
the truth table were validated:
- gamr (`auto_merge: false`) chained gamr-004 → gamr-005 in
  one session via gs-177's accumulator path; cycle 2's
  engineer imported the type cycle 1 had just authored,
  proving the successor-sees-predecessor semantic.
- generalstaff (`auto_merge: true`) chained gs-175 → gs-176
  in one session via the merge-then-reset path; bot/work
  fast-forwarded to master after each verified cycle, no
  unmerged-commits guard ever fired.

This is the core user-experience thesis Ray articulated
2026-04-18 morning: *"the process should need as little human
interaction as possible after seeding the initial idea."*
That goal is now structurally achievable for any registered
project, not just dogfood — which retroactively re-validates
Phase 3's whole experimental design.

**One open implicit gap (gs-184) deferred deliberately.** The
within-project task picker (in `scripts/run_bot.sh`'s claude-p
prompt) has no defined tiebreak between same-priority entries.
Today's workaround was to demote gs-173 from P1 to P2
temporarily so gs-171 was uniquely P1. The structural fix —
adding "lowest gs-NNN id first" as the tiebreak rule in the
prompt — is interactive-only (run_bot.sh is hands-off) and
small (one prompt line); queued as gs-184 marked
interactive-only per the new CLAUDE.md "Hands-off-aware task
queueing" convention. Workaround-fine until same-priority
collisions become routine.
