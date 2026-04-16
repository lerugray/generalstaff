# Hammerstein Observations — Claude Side (GeneralStaff)

Claude-side observation log for the GeneralStaff project.
Interactive Claude sessions and future autonomous bot runs both
write here, with headers distinguishing the source. Mirrors
`catalogdna/docs/internal/Hammerstein Observations - Bot.md`.

Same ground rules as Ray's log: append-only, log negatives
aggressively, counter-observations > confirmations, selection
bias is the enemy. Every entry MUST start with a source header.

---

### [interactive Claude — 2026-04-15, pivot session]

Five observations from the session that produced GeneralStaff's
open-source pivot. All are hypothesis-generating, not proven.
They need data from Phase 1 cycles to confirm or falsify.

**1. The Polsia deep-dive validated the Hammerstein framework
externally.**

Polsia's #1 user complaint (Trustpilot, 65% one-star) is false
task completions: the bot marks work done without verifying it.
This is literally the stupid-industrious failure mode — the
system is grinding confidently, nobody's checking, damage
compounds. The founder's own monitoring failure (20 unanswered
Stripe disputes from a broken support email route that almost
got their account flagged) is the same pattern at the
platform-operator level. The Hammerstein framework predicted
this failure class before we looked at Polsia's reviews.

Counter-observation to watch for: maybe Polsia's failure is
just "early-stage startup bugs" and they'll fix it with better
QA. If they do, the verification-gate differentiator weakens.
Track Polsia's Trustpilot trend over the next 3-6 months. If
the false-completion complaints persist after they've had time
to ship fixes, it's structural, not early-stage.

**2. The verification gate is the first Boolean implementation
of the Hammerstein framework.**

catalogdna's Hammerstein implementation is instruction-level:
the bot is told "be clever-lazy" and "verify destructive
premises" in CLAUDE-AUTONOMOUS.md. The bot follows the
instructions (mostly). But the instructions are prompts, not
constraints — the model CAN ignore them.

GeneralStaff's verification gate (Hard Rule #6) is a different
kind of implementation: a Boolean in the dispatcher that
physically cannot mark fake work done. The model doesn't
decide whether verification passes; the dispatcher runs the
tests and reads the exit code. This is Hammerstein-as-code,
not Hammerstein-as-instructions.

Hypothesis: code-level enforcement will catch failures that
instruction-level enforcement misses. Test this in Phase 1 by
comparing: (a) what catalogdna's bot CLAIMED it did (marked-done
tasks) vs. (b) what the verification gate independently
confirms. If there's ever a gap, that's the proof point.

**3. "Bring your own imagination" is the clever-lazy move for
the product itself.**

Instead of building a startup-idea generator (which would
require solving a creative problem — the domain where bots
produce slop), GeneralStaff lets the user bring their own idea
and runs the execution. That's the product being clever-lazy:
find the work the user doesn't want to do (mechanical
execution), delegate it; leave the work only the user can do
(imagination, taste, direction) with the user.

Polsia's approach is stupid-industrious at the product level:
it tries to do EVERYTHING (strategy, engineering, marketing,
support, growth), including the creative parts where it
reliably produces generic slop. The Hammerstein framework
predicts this will always produce homogenized output, and
Polsia's reviews confirm it ("generic marketing copy," "the
information is completely false").

Counter-observation: maybe there's a version of creative
delegation that works (e.g., creative delegation WITH a
verification gate — "generate 10 marketing variants, human
picks the best one"). The Hard Rule #1 default-off creative
roles allow testing this hypothesis later without betting the
product on it now.

**4. catalogdna's bot infra matured because the Hammerstein
framework compounds.**

The Phase A/B protocol, the "verify destructive premises" rule,
the "stop and write a note in bot_errors.md" instruction, the
"clever-lazy over stupid-industrious" operating frame, the
5-commit soft cap on Phase B, the "abandon-and-move-on rule"
for tasks the bot can't do well — these are all Hammerstein
implementations that catalogdna developed over 22+ bot runs.
Each run that produced a negative observation led to a new
rule that prevented recurrence.

This is the framework compounding: run → observe → codify rule
→ next run is better → observe → codify → repeat. The rules
are the accumulated clever-lazy wisdom of the bot's own
history. GeneralStaff inheriting these patterns isn't copying;
it's the framework's compounding flowing into a new project.

Prediction: GeneralStaff will develop its own Hammerstein rules
within 5-10 Phase 1 cycles that are specific to the
meta-dispatcher context (not borrowed from catalogdna). This
log exists to capture those. If the first 10 cycles produce no
new observations, that's a negative signal — it means either
the framework isn't being applied, or the bot isn't encountering
novel failure modes, or the logging discipline has lapsed.

**5. The game-design angle is load-bearing, not decorative.**

Ray's instinct to frame the dispatcher as a tabletop RPG
(kriegspiel/GM metaphor) maps a complex system onto a
well-understood game-design vocabulary. Game designers think in
systems, affordances, failure modes, and turn structure. The
Hammerstein framework is itself a game-design tool (four
quadrants = four player archetypes). The fact that a game
designer found the framework and applied it to autonomous bots
is not coincidental — the framework IS game design applied to
organizational theory.

This matters for GeneralStaff because it means the design
vocabulary (verification gate = rules enforcement, hands-off
list = forbidden squares, morning digest = session recap,
cycle = turn, STOP file = stand-down order) is not a metaphor
overlaid on engineering — it's the actual mental model the
project was designed with. The kriegspiel UI vision (Phase 5.5+)
will work because it matches the underlying architecture, not
despite it.

No counter-observation yet — this is a structural claim about
the project's design vocabulary, not an empirical hypothesis.
It becomes testable when external users encounter the UI and
either find the metaphor intuitive or confusing.

### [interactive Claude — 2026-04-15, cross-project + experimental validation]

After reviewing the full body of Hammerstein work across Ray's
projects (catalogdna 22 bot runs + 3 interactive sessions,
personal site 8 observation entries, Retrogaze scaffold, the
Medium article "Von Hammerstein's Ghost," the research brief
citing 7 academic papers, and 5 completed experiments with
Claude Sonnet 4.6), three findings matter for GeneralStaff:

**1. The experiments quantify the baseline.** Claude Sonnet 4.6
falls 64% clever+industrious at baseline, 0% stupid+industrious.
Prompt-level identity priming could only induce
stupid+industrious behavior in 1.7% of runs. The dangerous
quadrant resists prompting — it requires training-time
corruption (per MacDiarmid et al. 2025, Betley et al. 2025),
not prompt manipulation.

Implication for GeneralStaff: the verification gate isn't
guarding against a model that's frequently stupid+industrious.
It's guarding against the ~2% tail where the model acts
stupid+industrious despite its baseline tendency. That 2% is
where false task completions live. The gate's job is to catch
the rare-but-compounding cases, not the common ones. This makes
the gate MORE important, not less — rare events with
compounding damage are exactly what structural gates exist for.

**2. The inoculation experiment proves Hammerstein's core
insight.** A single reframing prompt that says "hacking is
acceptable" removes the commitment (industriousness) without
removing the capability. The danger was never capability — it
was misdirected commitment. For GeneralStaff: the verification
gate works not by making the bot smarter (it's already 64%
clever+industrious), but by removing the bot's ability to
COMMIT to a false completion. The gate catches the misdirected
commitment before it ships.

**3. The cross-project data confirms Ray's "initial negatives
shift" hypothesis.** catalogdna runs 10-12 (heavy negatives:
stale premises, env mismatches, venv missing) → runs 13-15
(fix-and-verify cycles) → runs 18-22 (stable execution, 12
commits per run, sophisticated observations). Personal site
shows early-phase taxonomy expansion (8 distinct failure
categories in 2 days) without the shift yet — project is too
young, but the pattern matches catalogdna's early phase.

The mechanism is NOT prevention. It's **legible failure →
structural fix → verification → compounding**. The append-only
log is what makes it work across sessions: without it, "the
framework worked" blurs into "we got lucky." Run 18 of
catalogdna is the strongest evidence — the bot wrote a
structural diagnosis of its own failure mode unprompted,
demonstrating the framework operating at the meta level.

**What this means for GeneralStaff specifically:**

- The framework is NOT theoretical for Ray. It's backed by
  experimental data (n=3, needs n=5 re-run), 22+ bot runs, 8
  observation entries, a published article, and a 677-line
  research brief citing 7 alignment papers. Future sessions
  should treat it as battle-tested, not speculative.
- The verification gate's design is aligned with the
  experimental findings: it catches the ~2% tail, not the 64%
  baseline. That's the right shape.
- The "expect early negatives, track decline over time"
  prediction is supported by catalogdna's run history. Phase 1
  should track this explicitly in the Hammerstein logs.
- The article + experiments are themselves a portfolio piece
  that adds credibility to GeneralStaff's positioning. When
  GeneralStaff launches, the Hammerstein article is
  ready-made intellectual backing for "why verification-first
  matters" — it's not just an opinion, it's experimentally
  supported.

Sources reviewed:
- `hammerstein experiments/hammerstein-article/article_draft.md`
- `hammerstein experiments/hammerstein-article/research_brief.md`
- `hammerstein experiments/hammerstein-ai-misalignment/` (5 experiments)
- `personal site/vault/hammerstein-log/observations.md` (8 entries)
- `personal site/src/content/writing/hammerstein.md` (published essay)
- `catalogdna/docs/internal/Hammerstein Observations Log.md`
- `catalogdna/docs/internal/Hammerstein Observations - Bot.md`

### [interactive Claude — 2026-04-15, response to Ray's log entry]

Ray's first Hammerstein entry (same day) pushes back on my
framing in observations #1 and #4: *"initial negative signals
are not a bad thing — across a couple projects I've noticed
that initial negative signals exist in a brand new project
and as the project matures, those tend to shift."*

This is an important correction. I treated Polsia's negative
signals (false completions, monitoring failures) as evidence of
structural failure. Ray's read is more nuanced: negative signals
in a NEW project are expected — the framework surfaces them
precisely so they can be addressed. The failure mode isn't "the
project has negative signals." The failure mode is "the project
has negative signals and nobody acts on them."

**Revised hypothesis for observation #1:** Polsia's problem
isn't early-stage bugs (every project has those). Polsia's
problem is that its architecture doesn't SURFACE bugs to anyone
who can fix them — no audit log, no user-facing verification,
opacity everywhere. The negative signals stay hidden until they
explode into Trustpilot reviews. GeneralStaff's differentiator
isn't "no negative signals" — it's "negative signals are visible
on day one via the audit log and verification gate, so they get
fixed instead of compounding."

**Revised prediction for observation #4:** The first 10 Phase 1
cycles SHOULD produce negative observations. If they don't,
that's suspicious — either the logging discipline has lapsed, or
the system is too simple to surface anything interesting. The
framework working correctly looks like: lots of early negatives,
declining over time as the rules compound and the edge cases get
codified. Ray's cross-project data point (observed this pattern
across multiple projects) makes this a testable prediction.

**Counter-prediction worth tracking:** If GeneralStaff's
negative signals DON'T decline over 10-20 cycles the way Ray
has seen in other projects, that would be evidence that either
(a) the meta-dispatcher context is structurally harder than
per-project bot work, or (b) the framework doesn't generalize
to fleet-level orchestration the same way it does to
single-project bots. Either finding would be valuable.

### [interactive Claude — 2026-04-16, first build session + dogfooding]

Four observations from the first session that produced working
code and ran live cycles. The design-to-execution transition
surfaced things that design alone could not.

**1. Dogfooding validates "bring your own imagination" from the
inside out.**

Ray's decision to make GeneralStaff its own first test project
instead of catalogdna was a "bring your own imagination" move
applied reflexively. The dispatcher doesn't care what project it
manages — it runs cycles, verifies work, logs results. The
project's own imagination (what tasks to assign, what "good"
looks like) comes from the backlog and the test suite, not from
the dispatcher. The fact that the dispatcher can build itself
without any special-casing proves the abstraction is real, not
theoretical.

This also means the dogfooding feedback loop is tighter than any
external project would provide: bugs in the dispatcher are
surfaced BY the dispatcher running against the dispatcher's own
code. The branch-awareness bug (observation #2) was found this
way — the dispatcher's own cycle exposed a flaw in the
dispatcher's own cycle orchestration.

Counter-observation: dogfooding can create a false sense of
generality. A tool that works well on itself might fail on
structurally different projects (monorepo layouts, non-TypeScript
stacks, projects with external service dependencies). The second
test project (whenever it comes) is the real generality test.
If the dispatcher needs significant changes to manage a project
that isn't itself, that's evidence the Phase 1 abstractions were
shaped too closely around the dogfood case.

**2. The branch-awareness bug is the "initial negatives shift"
in real time.**

Ray's observation from the 2026-04-15 log — that initial
negative signals are expected in new projects and tend to shift
as the project matures — played out within a single session.
Cycle 1 produced a negative (empty diff, reviewer correctly
flagged nothing to verify). The bug was identified, diagnosed,
and fixed within one cycle. Cycle 2 onward: all verified. The
negative shifted in under an hour.

This is the fastest instance of the pattern in Ray's
cross-project data. catalogdna took runs 10-15 to shift from
heavy negatives to stable execution. GeneralStaff did it in one
cycle. Possible explanations: (a) the framework knowledge was
already encoded in the design docs from catalogdna's experience,
so the starting point was higher; (b) dogfooding creates a
tighter feedback loop than cross-project management; (c) the
bug was genuinely simple. Probably all three.

Testable prediction: the NEXT set of negatives (gs-006 through
gs-010 or beyond) will be harder to fix than the branch-awareness
bug, because the easy plumbing issues are now resolved. If
cycles 6-10 are all clean verified with no new bugs surfaced,
that's either evidence the plumbing is solid or evidence the
tasks aren't exercising enough of the system. Track which.

**3. The reviewer agent maintained integrity under bad input.**

When the dispatcher fed the reviewer an empty diff (due to the
branch-awareness bug), the reviewer did not false-positive. It
said "nothing to verify" and returned a verdict that reflected
reality. This is the verification gate working exactly as
designed: it caught a false completion (the engineer "finished"
but the diff was empty) instead of rubber-stamping it.

This matters because Polsia's #1 failure mode (per the
2026-04-15 analysis) is false completions — the bot marks work
done without verifying. GeneralStaff's reviewer, on its very
first cycle, demonstrated the opposite behavior: it refused to
verify work that wasn't actually present. The gate held even
when the input was garbage.

Counter-observation: this was an easy case. An empty diff is
obviously wrong. The harder test is when the diff contains
plausible-looking but subtly incorrect code — code that passes
tests but introduces a latent bug, or code that technically
satisfies the task description but violates an unstated
convention. The reviewer needs to catch THOSE cases to be a
real differentiator. 5 cycles is too few to know if it can.
Track the first time the reviewer lets something through that
it shouldn't have.

**4. Five verified cycles with zero false positives is a data
point, not proof.**

5/5 bot tasks completed with clean verified verdicts. The
verification gate never false-positived. This is good, but the
sample size is small and the tasks were straightforward (test
coverage and code quality improvements on a young codebase).
The real test of the verification gate comes when: (a) the
tasks are harder (architectural changes, cross-module
refactoring, performance optimization); (b) the codebase is
larger (more surface area for subtle breakage); (c) the
engineer makes a mistake that passes tests but is wrong for
other reasons.

For now, the 5/5 record establishes a baseline. The metric to
track going forward is not "what percentage of cycles verify"
but "when the gate DOES reject, was the rejection correct?"
A gate that verifies everything is useless — it's just
rubber-stamping. The gate's value is proven by true negatives
(correct rejections), not by true positives (correct
verifications). We need cycles where the engineer fails and
the reviewer catches it. Until that happens, the gate is
promising but unproven on the hard cases.

Testable prediction: within the first 20 cycles, the reviewer
will reject at least one task that the engineer submitted as
complete. If it doesn't, either the tasks are too easy or the
reviewer's threshold is too low. Both would need adjustment.

### [interactive Claude — 2026-04-16, full-day build session]

Four observations from the afternoon portion of a 10-hour
session (53 tasks, 35+ autonomous cycles, 327 tests, 23 source
modules). The morning observations above covered cycles 1-12.
These cover the full arc through cycle 35+ and what the
completed session reveals about the framework.

**1. The dispatcher architecture IS a context management
strategy.**

Each cycle's `claude -p` gets fresh context, does work, exits.
The orchestrator only sees results via git. This is why the 1M
context session lasted 10 hours without compacting — the heavy
work was delegated out of the main context. The interactive
session handled task design, backlog loading, merge decisions,
and bug diagnosis. The expensive work (reading source files,
writing tests, implementing features) happened in disposable
sub-contexts that were discarded after each cycle.

This is Hammerstein-as-architecture at the infrastructure level.
The clever-lazy move isn't just "delegate work to the bot" — it's
"delegate work in a way that keeps the orchestrator's context
clean." The dispatcher pattern solves two problems simultaneously:
(a) the bot gets fresh context for each task (no stale
assumptions from previous cycles), and (b) the orchestrator
avoids context bloat from accumulated implementation details.

Counter-observation: this only works because git is the
communication channel. If the orchestrator needed to pass
context directly to the engineer (e.g., "here's what I learned
from the last 5 cycles"), the context savings would evaporate.
The architectural constraint — communication only via commits
and diffs — is load-bearing. Any future feature that requires
richer inter-cycle context (e.g., "the engineer should know
about the bug found in the previous cycle") would break this
property. Track whether that need arises and how it's handled.

**2. Misdiagnosis is the expensive failure mode.**

We attributed cycles 21-23 failing to "classifier blocking Bash"
when it was actually stale git worktree registrations on Windows.
Three cycles wasted before reading the actual error message.
The framework's "log negatives aggressively" rule exists
precisely to prevent this — but only works if you read the logs,
not just the symptoms.

The cost of misdiagnosis is not just the wasted cycles. It's
the wasted TRUST. If you attribute failures to the wrong cause,
your fixes address the wrong thing, and the real problem persists.
The worktree registration issue would have continued causing
failures indefinitely if we'd kept "fixing" the classifier.

Testable prediction: the next time a cycle fails for a
non-obvious reason, the first diagnosis will be wrong. This is
not pessimism — it's the base rate. Complex systems fail in
complex ways, and the most available explanation (the one that
matches recent experience) is usually not the actual cause. The
framework's counter-measure is the audit log: read the actual
error, not your theory about the error.

**3. 50 tasks in one session is the cross-project compounding
prediction confirmed.**

Ray noted in his Hammerstein entry that GeneralStaff inherited
patterns from catalogdna's 22 runs and hit maturity in one
session. This is the first empirical evidence that the
Hammerstein framework compounds ACROSS projects, not just within
them.

The mechanism: codified rules (hands-off lists, verification
gates, worktree isolation) transfer as architecture, not as
instructions. catalogdna's bot learned over 22 runs that worktree
isolation prevents branch conflicts. That learning was encoded
into GeneralStaff's design docs before the first line of code
was written. The 53 tasks in one session are built on top of 22
runs of accumulated wisdom from another project.

This is the framework's compounding function operating at one
level higher than previously observed. Within a project, the
compounding is: run N's failures become run N+1's rules. Across
projects, the compounding is: project A's mature rules become
project B's starting architecture. The starting point is higher,
so the initial-negatives phase is shorter, and productive
output begins sooner.

Counter-observation: this could be a sample-size-of-one
artifact. GeneralStaff inherited from catalogdna, and both are
TypeScript projects managed by the same person with the same
model. The cross-project compounding hypothesis is only
meaningful if it holds for a structurally different project
(different language, different domain, different operator). The
second project Ray adds to GeneralStaff's fleet (probably
catalogdna itself) will partially test this, but a true test
requires a project where the inherited rules might NOT apply.

**4. The verification gate's false-positive rate is zero.**

Across 35+ cycles, the gate never approved bad work (no false
positives) and correctly rejected hands-off violations and test
failures (3 true negatives). The false-positive rate is the
number that matters for trust — a gate with false negatives
(missed bad work) is useless, but a gate with false positives
(rejected good work) is merely annoying. Zero false positives
after 35 cycles is the trust-building metric.

The 3 true negatives are individually important:
- Two reviewer.ts hands-off violations: the engineer modified a
  file on the hands-off list, and the gate caught it. Both were
  subsequently approved by human review (the changes were fine,
  but the gate was right to flag them — the policy existed for
  a reason).
- One verification gate failure from worktree state: the test
  environment was in a bad state, and the gate correctly refused
  to verify work it couldn't confirm.

The zero false-positive record also means the gate has NOT been
tested under adversarial conditions. All 35+ cycles involved a
cooperative engineer (Claude following instructions). The gate's
robustness against a model that's actively trying to sneak bad
work through — the stupid-industrious failure mode — is still
untested. The experimental data (Hammerstein experiments,
2026-04-15 entry) suggests this is a ~2% base rate, so it may
take 50+ cycles to encounter naturally. But the gate's value
is precisely in catching that tail, so the absence of a natural
test is not evidence of robustness.

Testable prediction: the first false negative (bad work that
the gate approves) will involve a change that passes all tests
but violates an unstated convention or introduces a latent bug
that only manifests under conditions the test suite doesn't
cover. This is the class of failure that Boolean verification
(tests pass/fail) cannot catch. If it happens within the next
50 cycles, track whether a structural fix is possible or
whether it reveals a fundamental limitation of test-based
verification.

### [interactive Claude — 2026-04-16, home-PC observation run: dispatcher-level stupid+industrious caught]

One observation — the richest of the project so far. The first
home-PC observation run surfaced a **dispatcher-level**
stupid+industrious failure that 35+ work-PC cycles had been
silently masking.

**What happened.** Three cycles of an observation session. All
three "verified" by the reviewer. All three diffs correctly
implemented gs-056 (log rotation in `clean.ts` + tests). The
verification gate did exactly its job: each diff matched its
task, was verified, and was rubber-stamped correctly.

But zero of the three cycles' code reached `master`. Each cycle's
engineer commit was **orphaned**. Git reflog shows `7e11b93`,
`84333cf`, `319bb65` — three commits on `bot/work`, only one
(the last) reachable from any branch, and none of them from
`master`. The verified work existed, then was garbage-collected.

**Root cause.** `cycle.ts` line 295 (before the fix):
```
await $`git -C ${project.path} branch -f ${branch} HEAD`.quiet();
```
This is the gs-012 "auto-update bot/work to HEAD" feature. It
runs at the **start** of each cycle to give the engineer a fresh
base. The implicit assumption: the prior cycle's bot-work has
already been merged into `HEAD`. But no code anywhere in the
dispatcher performs that merge. On the work PC, the merges were
happening manually (the "Merge branch 'bot/work'" commits in
work-PC git log are not programmatic — they're Ray or interactive
Claude doing it by hand between cycles). On a fresh home-PC
session with zero manual merges, three consecutive cycles
reimplemented gs-056 because each commit got overwritten by the
next cycle's reset.

**This is the Hammerstein framework applied at the wrong layer.**
The project's design effort has been focused on preventing the
*engineer* (the per-cycle `claude -p` subprocess) from being
stupid+industrious. Hard Rules 1, 5, 6, 7, and 9 are all
engineer-level structural guards: hands-off lists, verification
gate, scope match. Those rules worked. The engineer was clever
and industrious — it wrote correct, verified code three times.

The failure was one layer up: the **dispatcher itself** was
stupid+industrious. It confidently ran cycles end-to-end —
picking projects, spawning engineers, running verification,
recording verdicts — and threw the output away. The reviewer
verdicts were correct. The cycle-end PROGRESS entries were
correct. The per-cycle digests were correct. Every component
was doing its declared job. But the **orchestration contract
had a silent hole** between "cycle ends" and "next cycle begins,"
and no single component owned closing it.

Industriousness without judgment again. Damage compounding
again. This time the bot wasn't the offender — the bot's
manager was.

**How it was caught: dogfooding, specifically a fresh-machine
dogfood run.** The home-PC session is the first time GeneralStaff
has run against itself in a fresh state with no human-in-the-loop
merging. The work-PC 35+ cycles didn't catch this because Ray was
actively interactive — "let me commit this" and "let me merge
that" masked the gap. The moment we tried to use the system as
it's actually intended to be used (observation run, then overnight
unattended), the silent hole became a loud hole. This is the
"initial-negatives shift" pattern from Ray's 2026-04-15 log
playing out at the framework layer: a new use-case (unattended
cross-machine operation) surfaced a new failure class
(orchestration integration), which is now fixed.

**The fix is itself a Hammerstein structural guard.** The new
`countCommitsAhead` check in `cycle.ts` is a Boolean gate: before
destroying `bot/work`, verify it's already merged. If not:
- `auto_merge: true` — merge it, preserving the work.
- `auto_merge: false` — refuse to proceed, surface the problem
  with exact remediation instructions.

Either branch is *clever*-lazy: neither path silently destroys
work. The dispatcher can no longer be industrious-without-
judgment about `bot/work`. The same architectural pattern as
the verification gate — replace a prompt/convention with a
Boolean in code — applied one layer up.

**What this predicts.** There are probably more "silent holes"
of this shape in the dispatcher. The verification gate is at
cycle-level. The hands-off list is at file-level. But there's
no explicit structural guard for **orchestration integrity**
— the guarantee that verified work actually lands where it's
supposed to. This bug was the first such hole; it is unlikely
to be the last. Candidates to audit next:
- Does `session_end` ensure all verified cycles' work is on
  master before writing the digest? (currently no check)
- Does `auto-commit state` ever commit a stale state file that
  overwrites concurrent bot work? (possibly — needs audit)
- Does a mid-session STOP file + restart preserve
  partially-completed cycle state? (unknown, never tested)

Each of those is a potential stupid+industrious failure mode
at the dispatcher layer, hiding behind components that each
individually work.

**Counter-observation.** One possible alternative reading: this
isn't a framework failure, it's just a normal bug that the dogfood
cycle caught. Dogfooding catches bugs — that's not a
Hammerstein-specific insight. Counter-counter: what's
Hammerstein-specific is **why the bug was invisible for 35+
cycles**. It wasn't a latent race condition or a rare
concurrency issue — it was a structural gap that fired on every
cycle. The work-PC session's 100% masking rate came from the
human compensating for the bug constantly without ever noticing
they were compensating. That's the signature of a framework-layer
failure: a thing that "works" only because a person is
invisibly load-bearing in the loop. Take the person out (as
unattended overnight operation does) and the gap becomes
obvious. Hammerstein's diagnostic — "you think it's working, but
the thing that's actually working is your own presence" — is
what we tested tonight, and it returned the predicted negative.

**Measurable outcome:** 3/3 cycles verified by the gate with
0 false positives. 3/3 cycles' work correctly preserved after
the fix + manual recovery merge. 1 new structural guard
(cycle.ts `countCommitsAhead`) added. 1 new Hard-Rule-#4
opt-in (dogfood `auto_merge: true`) after 35+ clean cycles.
337 tests passing. Framework operating as designed, once the
hole is visible.
