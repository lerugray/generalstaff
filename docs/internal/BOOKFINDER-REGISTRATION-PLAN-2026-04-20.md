# Bookfinder General — GS registration plan (2026-04-20)

**Status:** DRAFT — plan document, not an execution. Written while
Ray is awake so the project-specific info lands verbatim from the
source rather than being reconstructed next session.

**Double duty:** this doc is also the informal "how to register a
new project with GeneralStaff" template. The process is exactly
the same for any other project registration; swap `bookfinder-general`
for the new id, fill in the stack-specific details, done. If the
template turns out to be useful for OSS users, promote the generic
parts to `docs/internal/REGISTER-A-PROJECT.md` later.

**Pre-req landed tonight:** gs-278 Phase A — `creative_work_allowed`
and related fields exist on `ProjectConfig` as of commit `4c52ff1`.
This plan depends on those fields. Phase B (gs-279) adds the actual
creative-cycle execution behaviors; Bookfinder can register and run
correctness-only cycles before gs-279 lands, then graduate to
creative cycles once it does.

---

## What Bookfinder General is

Python 3.11+ research tool. MCP server + Flask web UI + CLI. Hunts
books on Anna's Archive, downloads them via Playwright browser
automation, extracts text (PDF / EPUB), translates if needed,
summarizes. 9 MCP tools exposed to calling LLMs. Stop-slop rules
embedded in the summarizer.

Repo: `C:/Users/rweis/OneDrive/Documents/bookfinder-general`
Public: `github.com/lerugray/bookfinder-general`
Stars: 1 (as of 2026-04-20) — one real user.

Layout (from reading CLAUDE.md + source):
- `bookfinder_general/` — package (11 modules)
- `app.py` — Flask entrypoint
- `main.py` — CLI entrypoint
- `templates/index.html` — web UI
- `pyproject.toml` + `requirements.txt` — strict pinning, `==` only
- `CLAUDE.md` — project conventions, includes load-bearing rules
  (see "Hands-off rationale" below)
- No `tests/` directory yet — this is the first gap to fill
- `.claude/`, `.mcp.json` — tool config

---

## Recommended `projects.yaml` entry

Paste into `projects.yaml` alongside the existing gamr / generalstaff /
raybrain entries. Every value marked `# CONFIRM` is my best guess;
flag any that should be different and I'll update the plan.

```yaml
  - id: bookfinder-general
    path: C:/Users/rweis/OneDrive/Documents/bookfinder-general   # CONFIRM — current local path
    priority: 3                                   # CONFIRM — lower than gamr (2), higher than raybrain (placeholder)
    engineer_command: "bash engineer_command.sh ${cycle_budget_minutes}"  # claude path; switchable to aider later per task
    verification_command: >-
      python -m pytest tests/ -q
      && python -m ruff check bookfinder_general/ tests/
    # The `tests/` directory doesn't exist yet; the first queued task
    # (bf-001 below) adds a minimal pytest scaffold + one smoke test so
    # this command has something to gate on. Once that ships, the
    # verification gate is live; before it ships, every cycle will
    # fail the gate which is the correct behaviour — refuse to ship
    # unverified work.
    cycle_budget_minutes: 30
    work_detection: tasks_json                    # standard — GS manages tasks.json at state/<id>/
    concurrency_detection: worktree               # 10-min .bot-worktree freshness check, same as gamr
    branch: bot/work
    auto_merge: false                             # Hard Rule #4 — no auto-merge for the first 5 cycles
    hands_off:
      # Existing project conventions + safety-critical rules
      - CLAUDE.md                                 # load-bearing rules live here
      - README.md                                 # voice-sensitive; Ray's own copy
      - LICENSE
      - .claude/                                  # claude code config
      - .mcp.json
      - session-notes.md                          # Ray's personal notes

      # Dependency-pinning discipline (CLAUDE.md: pin exact versions)
      - pyproject.toml
      - requirements.txt

      # Load-bearing modules with hard rules in CLAUDE.md:
      #   - browser.py: Playwright-on-dedicated-thread invariant
      #   - mcp_server.py: stdout = JSON-RPC, no stray print()
      #   - summarizer.py: stop-slop rules embedded
      #   - search.py: relevance-ranking step, don't remove
      - bookfinder_general/browser.py
      - bookfinder_general/mcp_server.py
      - bookfinder_general/summarizer.py
      - bookfinder_general/search.py

      # Entrypoints the bot shouldn't silently reshape
      - app.py
      - main.py
      - START.bat

      # GS's own registration + tasks surface (can't be both user
      # and subject of the same tasks.json edit per-cycle)
      - state/bookfinder-general/MISSION.md

    # Creative-work opt-in (gs-278 Phase A, gs-279 Phase B pending)
    creative_work_allowed: true                   # CONFIRM — this is what the RULE-RELAXATION-2026-04-20 doc enables
    creative_work_branch: bot/creative-drafts
    creative_work_drafts_dir: drafts/
    voice_reference_paths:
      # Start with PIH's shortest complete manuals — give the engineer
      # a clear "this is Ray's voice" signal without drowning it in
      # ten thousand lines. Can be expanded later; order matters
      # (highest-signal first).
      - C:/Users/rweis/OneDrive/Documents/PIH/manuals/An Amateur Guide To Wargame Design.txt  # CONFIRM — good short voice sample?
      - C:/Users/rweis/OneDrive/Documents/PIH/manuals/CATALOG.md
      # TODO: add Ray-selected PIH manuals here. Rule of thumb: pick
      # 2-4 files totaling ~5000-15000 words. More than that and the
      # engineer prompt gets bloated; less and the voice signal is
      # too weak to transfer.

    notes: |
      First open-source-product managed project (1 GitHub star as of
      2026-04-20). Registered under the gs-278 / RULE-RELAXATION-2026-04-20
      creative-work carve-out — Hard Rule #1 is off for creative
      tasks on this project only (see that doc for guardrails).
      Load-bearing constraints from its own CLAUDE.md are encoded
      in the hands_off list above: MCP stdout discipline, Playwright
      thread-pinning, search relevance ranking, stop-slop rules.
      Dep pinning is strict — any task that bumps pyproject.toml or
      requirements.txt should be interactive_only.
```

---

## Recommended `state/bookfinder-general/MISSION.md`

Create this file inside the GeneralStaff repo at
`state/bookfinder-general/MISSION.md`. It's the project's scope
boundary — what the bot is allowed to work on vs. what is Ray's
judgment-only territory. The dispatcher reads it for scope
confirmation; the engineer reads it as part of the
task-picking prompt.

```markdown
# Bookfinder General — mission

## In scope (bot-pickable)

- Test coverage: expand the pytest suite that bf-001 seeds.
- Type hints: add full type annotations to modules with none
  currently (config.py, library.py, cli.py).
- Error handling: catch + log edge cases in extractor.py,
  download.py per the "every code path returns JSON, never
  raises" CLAUDE.md rule.
- Docstrings: write PEP 257 docstrings for public functions in
  any module except the four hands_off modules.
- Refactors with clear specs: extract helper functions, dedupe
  similar code paths, rename for clarity.
- Bug fixes with minimal-repro tests.
- Performance: micro-optimizations with before/after benchmarks
  (don't touch the large-PDF skip logic or EPUB exemption
  without a brief from Ray).

## In scope (creative-tagged, human-reviewed drafts)

- README section drafts — bot drafts to drafts/, Ray edits, Ray
  publishes.
- Launch post drafts (HN, r/selfhosted, r/LocalLLaMA variants).
- MCP tool usage examples for README.
- Feature blurbs for new functionality.
- Voice-calibrated to Ray's PIH manuals + any additions he
  supplies via voice_reference_paths.

## Out of scope (Ray only)

- Anything touching a hands_off file (see projects.yaml entry).
- Changing the Playwright threading model or MCP stdout
  discipline — those are CLAUDE.md "CRITICAL RULES" and encoded
  as hands_off.
- Dependency version changes (strict pinning convention).
- Redesigning the MCP tool surface (9 tools currently — adding
  or removing one is a product decision).
- Anything related to Anna's Archive's legal/compliance
  posture. The bot doesn't opine on that; Ray decides.
- User-facing copy that ships directly without Ray's review
  (creative tasks always land in drafts/, never published
  autonomously).
- Product direction, roadmap, pricing (if it ever gets a paid
  tier — currently free).

## Success signals

- Test suite grows cycle over cycle, verified rate stays high.
- No cycle rollbacks due to touching a CLAUDE.md "CRITICAL
  RULE" module — hands_off is doing its job.
- Creative drafts Ray can usably edit (≤ 2x rewrite effort vs.
  writing from scratch).
- Bot never publishes a creative draft directly (guardrail 2
  from RULE-RELAXATION-2026-04-20).
```

---

## Recommended initial `state/bookfinder-general/tasks.json`

Five tasks to seed the queue. First is the critical prerequisite
(get verification passing); the rest are genuine small wins the
bot can grind on.

```json
[
  {
    "id": "bf-001",
    "title": "Seed the test suite. **Scope:** (1) Create `tests/` directory with `tests/__init__.py`. (2) Add `tests/test_smoke.py` containing three offline tests: (a) `from bookfinder_general import search` imports cleanly, (b) `search._rank_by_relevance` returns results sorted by query-word overlap (test with known inputs), (c) `bookfinder_general.config.load()` or equivalent returns a dict with at least `library_path` populated. (3) Update pyproject.toml test extras to include `pytest==8.4.1` (pin exact per CLAUDE.md). Run `pip install -e .[test]` to install. (4) Verification command `python -m pytest tests/ -q && python -m ruff check bookfinder_general/ tests/` should now pass cleanly on master. **Must NOT:** touch any hands_off file, hit the network during tests, or use Playwright in tests. Expected diff: ~60-120 lines.",
    "status": "pending",
    "priority": 1,
    "expected_touches": [
      "tests/__init__.py",
      "tests/test_smoke.py",
      "pyproject.toml"
    ],
    "interactive_only": true,
    "interactive_only_reason": "pyproject.toml is in the hands_off list (strict dep pinning). bf-001 must be interactive because it adds a test-extras block to pyproject.toml. After bf-001 lands, the bot can pick up bf-002+ autonomously."
  },
  {
    "id": "bf-002",
    "title": "Add full type hints to `bookfinder_general/config.py`. Pure typing work — no behavior change. All function signatures get parameter and return annotations. All module-level constants get `Final[...]` annotations where appropriate. Add `from __future__ import annotations` at top of file. Verify with `python -m ruff check bookfinder_general/config.py` and `python -c 'import bookfinder_general.config'`. Expected diff: ~30-60 lines.",
    "status": "pending",
    "priority": 2,
    "expected_touches": ["bookfinder_general/config.py"]
  },
  {
    "id": "bf-003",
    "title": "Add full type hints to `bookfinder_general/library.py`. Same pattern as bf-002 — all function signatures, `from __future__ import annotations`, module-level constants. Pay attention to: any function that takes a path (use `Path` from pathlib, not `str`), any function that returns a dict (use `TypedDict` or a `dataclass`), any async functions. Verify with ruff + import smoke-test. Expected diff: ~50-100 lines.",
    "status": "pending",
    "priority": 2,
    "expected_touches": ["bookfinder_general/library.py"]
  },
  {
    "id": "bf-004",
    "title": "Add PEP 257 docstrings to public functions in `bookfinder_general/cli.py`. Docstring each public function with: one-line summary, Args block listing each parameter with type and purpose, Returns block describing return shape, Raises block for documented exceptions. Private functions (leading underscore) get one-line docstrings only. Verify with `python -m ruff check bookfinder_general/cli.py` (pydocstyle rules if enabled). Expected diff: ~40-90 lines.",
    "status": "pending",
    "priority": 2,
    "expected_touches": ["bookfinder_general/cli.py"]
  },
  {
    "id": "bf-005",
    "title": "Draft a 300-word README section titled 'Why Bookfinder exists' (or similar — engineer picks best title from 3 candidates). Voice-calibrated to the PIH manuals in `voice_reference_paths`. Drafts go to `drafts/readme-why-section-v1.md` — NOT into README.md directly (README.md is hands_off). Ray edits the draft and decides whether to fold into README. Audience: open-source developers browsing GitHub. Message: what gap Bookfinder fills (Anna's Archive search that actually returns the right book; cleanly extracts text; summarizes with stop-slop rules so the output isn't LLM boilerplate). Tone: technical, dry humor, no marketing-speak. Do NOT mention 'unleash' / 'revolutionize' / any engagement-bait verbs.",
    "status": "pending",
    "priority": 3,
    "creative": true,
    "interactive_only": true,
    "interactive_only_reason": "Creative-cycle execution behaviors (gs-279: voice-reference prompt prepend, reviewer-skip, creative-branch override) not yet landed. Flip to bot-pickable once gs-279 ships."
  }
]
```

---

## Registration checklist — the mechanical steps

When the plan is approved and Ray wants to execute (any future
session), the steps are:

1. Append the `projects.yaml` entry from above (the file itself is
   hands_off on the generalstaff dogfood project — interactive
   edit only).
2. `mkdir -p state/bookfinder-general/` in the GeneralStaff repo.
3. Write `state/bookfinder-general/MISSION.md` with the content
   above.
4. Write `state/bookfinder-general/tasks.json` with the content
   above.
5. Make sure `bookfinder-general` has its own `engineer_command.sh`
   at the project root. Use gamr's as a template; only change the
   project-id references and the install command (`pip install -e .`
   instead of `bun install`).
6. Create `bot/work` branch in the bookfinder-general repo
   (`git -C /path/to/bookfinder-general branch bot/work master`).
7. Run `generalstaff status --projects` to confirm the registration
   parses cleanly.
8. Launch a session with `bash scripts/run_session.bat 45 openrouter`
   (or equivalent) — the first cycle will pick up bf-001 (but since
   bf-001 is interactive_only, the bot will skip it). Handle bf-001
   interactively, then rerun the session — bf-002 should land
   autonomously.

---

## Decisions (confirmed by Ray, 2026-04-20 ~04:45 EDT)

1. **Path.** Home PC is `C:/Users/rweis/OneDrive/Documents/bookfinder-general`
   — confirmed. Work PC path is slightly different and will be set
   when Ray resumes from there, but most bot work runs on home PC
   so it's fine to register with the home-PC path for now. When the
   work-PC path is known, update `projects.yaml` at that point
   (interactive edit — projects.yaml is hands_off).
2. **Priority 3** — confirmed.
3. **Voice-reference paths** — confirmed:
   `An Amateur Guide To Wargame Design.txt` + `CATALOG.md` from
   PIH/manuals/. **Future addition, not for initial registration:**
   Ray's Facebook export just arrived and raybrain is spinning up
   an ingestion bot to process it. Once raybrain publishes a cleaned
   voice corpus from the FB export, add a pointer to this project's
   `voice_reference_paths` — the FB corpus will have much richer
   first-person idiom signal than the wargame manuals (years of
   informal writing).
4. **Seeded tasks (bf-001..005)** — all 5 confirmed as-is, no swaps.
5. **Creative-work sequencing: Option A.** Register now with
   `creative_work_allowed: true`; bf-005 ships with
   `interactive_only: true` (reason references gs-279 dependency).
   Bot grinds bf-001..004 autonomously in the interim. When
   gs-279 ships, flip bf-005's `interactive_only` to `false` and
   it becomes bot-pickable with full creative-cycle behaviors.

No remaining blockers — registration is executable whenever Ray
wants to do it in a dedicated session.

---

## What this plan deliberately doesn't do

- **Register the project tonight.** Plan only. Registration is a
  deliberate ceremony (per CLAUDE.md §"Adding a project is a
  ceremony, not a casual edit") and belongs in a dedicated session
  where Ray can watch the first cycle.
- **Speculate about commercial viability or a paid tier.** That's
  Ray's call, and Hard Rule #1 says the bot doesn't draft product
  strategy.
- **Propose branch protections / CI pipelines / pre-commit hooks
  beyond what bf-001 requires.** Each of those is its own task
  with its own scope; piling them all into bf-001 would make it
  un-reviewable.
- **Encode anything about Anna's Archive's legal posture.** Out
  of scope per MISSION.md.

---

## Template notes (the reusable part)

For any future project registration, the generic structure this
doc established is:

1. **Read the existing project** — its README, CLAUDE.md (if any),
   pyproject.toml / package.json / Cargo.toml, directory layout.
   Everything in the projects.yaml entry below should be
   re-derivable from the source.
2. **Identify load-bearing invariants** — anything called out in
   the project's own docs as a "critical rule" or "don't touch"
   goes straight into `hands_off`. The bot is industrious; the
   way to keep it from damaging the load-bearing parts is to make
   them un-touchable.
3. **Find the first verification gap** — if no tests exist, the
   first task is "seed the test suite." Without a verification
   command that meaningfully passes, every cycle is a no-op.
4. **Seed 3–5 small wins + 1 creative task (if opted in)** —
   enough to prove the verification loop works before queueing
   anything speculative.
5. **Flag `interactive_only: true` on anything that touches
   hands_off files** at queue time, not cycle time. Per CLAUDE.md
   §"Hands-off-aware task queueing": the bot can't land edits to
   a hands_off file anyway, so queueing it as bot-pickable wastes
   a full cycle.

This template could be promoted to
`docs/internal/REGISTER-A-PROJECT.md` if / when we want to
document the registration process for OSS users. That's a
separate task — don't do it speculatively.
