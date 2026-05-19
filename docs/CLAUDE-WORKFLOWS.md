# Working with Claude Code over a GeneralStaff portfolio

GeneralStaff manages a fleet of projects, each with its own task ledger.
A lot of fleet work is not "run the dispatcher" — it is an operator
sitting in an interactive Claude Code session, deciding what to unblock
next across several projects at once. That session has a failure mode:
Claude either asks too much (a wall of questions before any work starts)
or asks too little (it guesses, and the guesses are wrong).

This doc describes a workflow that avoids both. It is the **bite-sized
one-by-one decision pattern**. Use it when you open Claude Code to
unblock or triage a multi-project portfolio and several decisions need
to land.

## When to use it

- You are doing a portfolio sweep — "what can we unblock across these
  projects" — and 3 or more decisions need an operator call.
- A cross-project polish or cleanup pass where work is gated on taste,
  scope, or priority calls rather than on missing code.
- Any session where the queue is mostly "waiting on a human decision"
  rather than "waiting on implementation."

## When not to use it

- Single, well-specified tasks. Just do them.
- Strategic reframing where the operator needs to think in prose, not
  pick from options. Write the analysis; do not flatten it into a
  multiple-choice list.
- High-stakes decisions where a wrong default has real consequences —
  money, public-facing voice, anything destructive. Those get
  surfaced one at a time with full context, not bulk-approved.

## The pattern

### 1. Survey before you ask

Before surfacing a single decision, read the actual state of each
project in scope: recent `git log`, the latest session notes, the
relevant `tasks.json` files. Every recommendation you are about to make
must be grounded in what the repo actually contains right now — not in a
one-line project description, not in a stale memory of the project.

A `pending` task is not proof that work is needed. Bot cycles and
parallel sessions land work without always flipping the ledger. Verify
against `git log` first.

### 2. Draft strawmen with recommended leans

For each decision, write a short strawman: the question, the options,
and **your recommended lean**, marked. A useful convention is a `[LOCK]`
marker on the option you would default to:

> **vc-004 — relaunch framing.** Options: (a) Steam debut, (b) itch
> update post, (c) silent ship. `[LOCK: a]` — the project has no Steam
> presence yet, so "debut" is accurate and "relaunch" is not.

Marked leans let the operator bulk-approve the obvious ones and spend
attention only on the few that warrant discussion. Do not pretend to be
neutral when you have a real lean — a fake-neutral menu is decision
fatigue dressed up as respect.

### 3. Surface decisions one at a time

When the operator says to go one-by-one, surface each decision as a
single, concrete, bite-sized question — 3 to 4 options plus an escape
hatch — each carrying your recommended option. One question, one
answer, then the next. The operator can move fast without reading a
whole strawman document cold, and each answer locks the next move.

### 4. Execute between questions

As each decision locks, start the work it unblocks immediately — in the
same turn, in the background where the tool allows it. Do not collect
all the answers and then begin. The operator's answers should turn into
running work without a serial wait. By the time the last question is
answered, the first few tasks are already in flight.

### 5. Let answers correct the strawman

An operator's answer will sometimes reveal something the strawman got
wrong — a wrong assumption about a project's state, a constraint you did
not know. When that happens, fold the new reality into the *next*
question. Do not push forward on a framing the operator just corrected.
The strawman exists to be corrected, not defended.

### 6. Commit as you go

Update the task ledger, commit, and push after each decision lands — do
not batch state writes to the end. Every lock should leave the
repository in a resumable state. If the operator steps away mid-sweep,
the session so far is already saved and the next session can pick up
cleanly.

## Audit the leans before surfacing them

If a sweep carries non-trivial taste calls, it is worth running your
strawman through an adversarial check before surfacing it — a second
model, a red-team prompt, or the `/audit` skill if you have it
installed. Treat the result as adversarial input: if a lean gets flagged
as wrong-shaped or missing context, revise it, drop it from the
recommended slot, or surface the disagreement as part of the question.
"Looks fine" is signal too — surface as drafted.

Skip this check when the leans are mechanical or obvious. It is a
safeguard for genuine taste calls, not a ritual to run on every
decision.

## The short version

Survey first. Strawman with marked leans. Surface one decision at a
time. Execute between answers. Let answers correct the next question.
Commit as you go. The result is a session where the operator makes fast,
well-grounded calls and the work is already moving by the time they
finish.
