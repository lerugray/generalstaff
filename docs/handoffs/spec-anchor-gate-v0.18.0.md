# Build brief: spec-anchor gate and drift protections (v0.18.0)

Base: master @ 4f0e2d9 (v0.17.0). Work on this branch. Do not commit or push; leave changes in the working tree.
Read `AGENTS.md`, `CLAUDE.md` (Hard Rules), `src/judgment_gate.ts`, its call site in `src/cycle.ts` (step "3b"),
`src/projects.ts` (how `judgment_gate` is validated), `src/types.ts` (`GreenfieldTask`, progress event names),
`src/providers/registry.ts` + `src/providers/types.ts` (roles), `src/fork_ledger.ts`, `docs/JUDGMENT-GATE.md`,
`provider_config.yaml.example`, `README.md`, `CHANGELOG.md` (the v0.17.0 entry is the house style).

## The problem this solves

An autonomous fleet can build software that has little to do with what its owner asked for. The owner's request passes
through layers: spec, plan milestones, task cards, lanes, reviews. Each layer checks the layer above it, never the owner's
words, so a stand-in that enters once passes every later review. Two shapes recur:

1. **Drift through layers.** A task builds a rehearsal, demo, narrower product or a person-in-the-loop in place of the
   product the owner described, and every review passes it because each compares against the plan, not the owner.
2. **Mangled features.** The owner asks for an experience ("make these games playable in the normal mode") and the fleet
   builds an easier stand-in: a panel of setup fields, tables and dropdowns, manual bookkeeping, technical vocabulary
   where the owner described the software doing it for the user. Often it entered as a multiple-choice "pick" the
   owner made from option labels without seeing a picture, which later layers then treated as the owner's ruling.

The existing judgment gate (v0.7.0) asks "is this task load-bearing or slop?". It never reads the owner's spec. This
feature adds the missing check: **does this task build what the owner asked for?**

## Part 1: the spec-anchor gate (code, `src/spec_gate.ts`)

- **The anchor.** A project's `SPEC.md` at the project root (configurable per project: `spec_anchor: <relative path>`).
  Convention (document it): line 1 is one sentence in the owner's words saying what the software does for its user;
  then what the user does, in order; then an "Out of spec" list (stand-ins, person-in-the-loop, narrower products,
  anything the owner rejected). Built only from the owner's own words, each line citing its source.
- **Project config** in `projects.yaml` (validate in `src/projects.ts` like `judgment_gate`, add to `types.ts`, add a
  commented example to `projects.yaml.example`):
  - `spec_gate: off | flag | block` (default `off`, zero overhead when off).
  - `spec_anchor: SPEC.md` (default).
  - `owner_docs: [docs/GDD.md, ...]` optional list of owner-approved design docs whose exact quotes count as owner words.
  - `picture_first: false` (see Part 2).
- **Task fields** (optional, on greenfield tasks in `tasks.json`; extend the type and any validation):
  - `user_facing: true` when the task adds a new user-facing feature, mode or screen, or reshapes how one works.
  - `owner_words: string | string[]` the owner's own sentence(s) for THIS feature, verbatim, or the client's own words
    for client work.
  - `owner_quote: { text, source }` an exact quote from an `owner_docs` file, `source` = `path#section`. The gate checks
    mechanically that `text` occurs verbatim (whitespace-normalised) in that file and that the file is listed in
    `owner_docs`; a quote that is not found does not count (record why). A paraphrase never counts.
  - `first_screen: <relative path>` see Part 2.
  - Also accept an `OWNER-ASK: "<words>"` line inside a free-text card (for the CLI path below).
- **The checker.** An LLM judges the task against the anchor. Backend comes from `provider_config.yaml`: add a new role
  `spec_checker` to the registry (`ProviderRole`, `ALLOWED_ROLES`, example file, `docs/provider-config-format.md`).
  When the role is unrouted, fall back to the judgment gate's inline OpenRouter path with
  `GENERALSTAFF_SPEC_GATE_MODEL` (default: reuse `DEFAULT_GATE_MODEL`). Reads ONLY the anchor and the card (task title,
  description/body, owner words, kind fields), never the plan or other tasks. Prompt it to **assume drift** until the
  card shows otherwise. Write the prompt as a bundled asset `src/prompts/spec_gate.md` with a version number.
  Prompt content (in your own words, generic "owner", no names):
  - Decide KIND first: `build` (adds/changes software), `verify` (reviews, test plays, acceptance checks; never marked
    down for producing no change), `ship` (packaging, release steps).
  - ON-SPEC when afterwards the anchor's user gets more of the anchored product (a feature the anchor describes or
    clearly implies; user-facing polish; reliability; groundwork that names the later user-visible step it unlocks).
  - OFF-SPEC when the result is a stand-in, rehearsal or demo in place of the product; a person doing by hand what the
    software should do for the user; a narrower or different product; something the anchor lists as out of spec;
    groundwork naming no user-visible step; paperwork whose only reader is the process.
  - UNCLEAR when the card does not say what its work is for.
  - FEATURE WORDS: a build card that is user-facing (new feature/mode/screen or reshaping one) must carry owner words
    for that feature (task field, OWNER-ASK line, verified owner_quote). Without them: UNCLEAR, reason
    "no owner words for this feature". Exempt: fixes restoring approved behaviour, polish that keeps the feature's
    shape, packaging/release, verify cards. With them: OFF-SPEC when the card gives the user an easier stand-in for
    the experience the owner described (forms, setup fields, tables, dropdown walls, manual bookkeeping, file
    shuffling, technical vocabulary where the owner described the software doing it), or builds from a derived spec
    step or multiple-choice pick that disagrees with the owner's words. Set `stand_in: true` on such verdicts.
  - Reply ONE JSON object: `kind, verdict (ON-SPEC|OFF-SPEC|UNCLEAR), user_can (one plain sentence), anchor_step,
    reason, owner_words_present (bool), stand_in (bool)`.
  - Do the owner-words presence check mechanically too: if `user_facing: true` and no owner words/verified quote, the
    gate returns UNCLEAR without calling the model (cheaper, deterministic).
- **Completion discipline** (same as v0.17.0's reviewer): only a normally completed response with a parsable, schema-
  valid verdict counts. Timeouts, non-stop finish reasons, empty or malformed output = `error`.
- **Modes.** `flag`: log the verdict, proceed. `block`: proceed only on ON-SPEC; OFF-SPEC, UNCLEAR and `error` skip the
  cycle (fail closed; reason `spec_gate_<verdict>`). No anchor file: log a `no_anchor` warning and proceed in both modes.
- **Cache.** Key = sha256(prompt version + anchor text + card text). Store verdicts in `state/<project>/spec_checks.jsonl`
  (append-only; one JSON line each with timestamp, task id, key, model, verdict fields). A cached valid verdict for the
  same key is reused without a call. `error` verdicts are never cached.
- **Override.** `GENERALSTAFF_SPEC_GATE_OVERRIDE="<reason>"` (env) or `--override "<reason>"` on the CLI lets a blocked
  card proceed, for a checker outage or a plainly wrong verdict. The reason is required (non-empty, at least a few
  words) and is logged as a `spec_override` record. An override can NEVER pass a verdict with `stand_in: true`.
- **Cycle hook.** Step "3c" right after the judgment gate in `src/cycle.ts`, same shape: off = zero overhead; append a
  `spec_verdict` progress event (add to the event-name lists in `types.ts`); print one console line; on block-mode
  refusal set `result.reason` and `break assemble`. Must not run under verify-only (use `assertNotVerifyOnly` like the
  judgment gate does).
- **CLI.** `generalstaff spec check --project <id> --task <id> [--json] [--override "<reason>"]` and
  `generalstaff spec check --anchor <file> --card <file> [--json]` (for cards that are not tasks, e.g. a brief handed
  to an outside lane or a co-seat). Exit codes: 0 ON-SPEC, 3 OFF-SPEC, 4 UNCLEAR, 1 could not check, 0 with a warning
  when no anchor exists. Wire it into `src/cli.ts` and its help text following existing subcommands.

## Part 2: process protections (opt-in, enforced where GS can enforce them)

Document all six in `docs/SPEC-GATE.md`; enforce the ones marked CODE.

1. **The owner's words for the feature ride every card** (Part 1). CODE.
2. **Picks are not rulings.** Engineering choices (API shape, file layout, libraries) are the fleet's call and are never
   put to the owner as multiple choice. A product-shape choice the owner makes from a list of option labels without
   seeing a picture is recorded as a *seat option*, not an owner ruling. CODE where GS records owner decisions: look at
   `src/fork_ledger.ts` (parked items a person resolves). If a resolution is recorded there, add an optional
   `resolution_kind: ruling | seat_option` and refuse to record `ruling` unless the resolution carries quoted owner
   words; picks without words are stored as `seat_option`. If there is no natural place, document it only and say so
   in your report. Do not invent a large new subsystem.
3. **Picture first.** With `picture_first: true` on a project, a `user_facing: true` build task must carry
   `first_screen: <path>` pointing at an existing image or HTML file in the project (the owner has seen the first
   screen before it is built). In `block` mode a missing or nonexistent first_screen refuses the task (UNCLEAR, reason
   "no first-screen picture"). Fixes are exempt. CODE.
4. **Looks judge intent, not just pixels.** Any visual check quotes the owner's words and names the user; its first
   question is "would that user get what the owner asked for?" A screen nobody asked for is a FAIL. DOC + a template
   `examples/spec-gate/look-brief.md`.
5. **Client issues in the client's own words.** For client work, the issue list is what the client said; the fleet's own
   doubts are recorded as its own calls with a reason, never turned into client questions. DOC (owner_words carries the
   client's words; note this in the docs).
6. **Drift audit before a launch.** CODE: `generalstaff spec audit --project <id> [--out <file>]` writes a Markdown
   report listing every `user_facing` task (done and pending): its owner words (or "MISSING"), its latest spec verdict
   from the cache, any overrides, and a blank "what a user sees now" column for the person running the audit. It exits
   nonzero when any user-facing done task lacks owner words or has an OFF-SPEC/UNCLEAR latest verdict. DOC: run it
   before any launch or go-live decision and put the report in front of the owner with the go question.

Also add to docs: "A SPEC step derived from the owner's picks quotes the owner's original ask beside the pick; a
review that finds them disagreeing stops the card."

## Part 3: tests, docs, version

- Tests in `tests/` (bun test), matching existing judgment-gate test style: config validation; owner-words presence
  check; owner_quote verbatim verification (found / not found / file not in owner_docs); picture_first; verdict parse
  and schema validation; completion discipline (non-stop finish = error); modes (flag proceeds, block fails closed,
  no-anchor proceeds with warning); cache hit/miss and that errors are not cached; override needs a reason and never
  passes `stand_in`; cycle hook skip in block mode (mock the checker, like existing cycle tests do); CLI exit codes;
  `spec audit` report and exit code; provider role routing incl. fallback. No network in tests.
- Run `bun test 2>&1 | tail -15` and `bun x tsc --noEmit` and leave both green. Report before/after pass counts.
- Docs: new `docs/SPEC-GATE.md` (what it is, why, the anchor convention with a short generic SPEC.md example, config,
  task fields, modes, cache, override, CLI, the six protections, how it composes with the judgment gate and reviewer).
  `README.md`: add a short section after "What the gate does not catch" (or in "Optional layers"), plain English, and
  a Documentation link. `CHANGELOG.md`: a `## v0.18.0 — 2026-11-07` entry in the v0.17.0 style (lead paragraph of what
  changed for a user, then bullets). `package.json` version 0.18.0 and any other place the version string appears
  (grep for `0.17.0`). Add `examples/spec-gate/SPEC.md.example` and the look-brief template.
- Writing style for all docs: plain, direct sentences; no em-dashes; no marketing words; no filler.

## Fence

- Generic only: say "owner", "client", "user". No personal names, hostnames, private paths, keys, or references to any
  other repository.
- Do not change the judgment gate's or reviewer's behaviour. Additive only; `spec_gate: off` must leave every existing
  test and behaviour unchanged.
- No new runtime dependencies.
- Delete nothing outside your scope. Do not touch `docs/internal/`, `site/`, `web/` (unless the CLI help is mirrored
  there, then only that).

Final message: FIX SUBMITTED or FIX BLOCKED, then files changed, test counts before/after, typecheck result, and any
part you documented instead of coding (with why).
