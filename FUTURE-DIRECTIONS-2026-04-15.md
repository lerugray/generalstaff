# Future Directions — 2026-04-15 (evening chat capture)

**Status:** Captured during an end-of-session chat on 2026-04-15
evening. **None of these are commitments** — they're
forward-looking ideas that came up in conversation and are worth
preserving so they don't get lost in context.

Each section describes the problem the idea addresses, a rough
shape, and where in the phased plan it plausibly lives. Details
are for a later design session, not this one.

---

## 1. Simulation / Kriegspiel Mode (Phase 12+)

**Problem:** Before spending 40 engineer-hours on a project, is
it even worth building? Polsia's answer is "yes, always, pay us
$49 and we'll start building." That's the wrong default for a
principled tool. The right default is *"let's see if the plan
survives contact with reality first."*

**Shape:** A pre-cycle gate that runs a Monte Carlo simulation
of the project's plan (market fit, unit economics, distribution
channels, competitive response, failure modes) and reports back
with **confidence intervals, not single numbers**. Single-number
predictions are another form of slop — they project false
confidence. Confidence intervals are honest about uncertainty.

The user writes a "campaign plan" (markdown + JSON config
blocks), GeneralStaff runs the simulation, the simulation
outputs a go/no-go recommendation with rationale. Only then
does the project get registered for real cycles. That's the
kill-or-ship pattern made explicit: the simulation makes the
call honestly about its own uncertainty, and the user decides
based on the honest call.

**Why this fits the theme perfectly:** Kriegspiel was *literally*
this — Prussian general staff played battles on a table with
dispatches and umpires before committing real troops. The 19th
century Kriegsakademie used it for exactly this purpose. The
GeneralStaff mental model maps onto it directly: the simulation
is the tabletop wargame, the user is the commander reviewing
the outcome, the bots are the troops that only get deployed
after the simulation supports deployment.

**Public libraries that could power this:**

- **Mesa** (Python) — agent-based modeling framework
- **SimPy** (Python) — discrete event simulation
- **PyMC** (Python) — Bayesian Monte Carlo
- **scipy.stats** — basic statistical distributions + sampling
- **NetLogo** — agent-based modeling (legacy but well-tested)

The dispatcher doesn't need to build any of these — it wraps
them in a `generalstaff simulate <project>` subcommand that
takes the campaign plan as input and produces a report file.

**Critical design constraint:** the simulation must report
confidence intervals AND sensitivity analysis (which inputs
move the output most), NOT a single probability number. A
confidence interval forces honest framing ("70-90% chance of
covering costs in 18 months, depending on conversion
assumption"); a single number ("87%") is a lie pretending to
be data.

**Additional pattern:** a "stress test" mode that runs the
simulation with intentionally adversarial assumptions (2x
customer acquisition cost, half the conversion rate, a
competitor launch in month 3). If the project still survives
under stress, that's a much stronger signal than a single
happy-path run.

**Interaction with satire/absurdist projects:** the simulation
mode must be **optional**, not mandatory. Someone running a
satirical anti-profit project has no reason to simulate market
fit — they want the project to lose money gracefully. The
dispatcher honors this: simulation is a feature the user
activates, not a gate the user has to pass.

**Why this is Phase 12+:** it requires the rest of the system
(dispatcher, verification gate, audit log, local UI, cycle
chaining) to be stable first. It also requires prior investment
in designing the campaign plan schema, which is a separate
project on its own. Worth capturing now as a commitment to the
theme; not worth scoping now.

---

## 2. Model Plurality / Provider Routing (Phase 2 architectural, Phase 2+ use)

**Problem:** The biggest operational cost of running GeneralStaff
overnight on several projects is the Claude bill. A user who
wants to run 5 projects nightly but only has a Claude Pro
subscription will burn through their usage in days. This is
the single biggest barrier to "soft launch to 5 real users"
because soft-launch users won't pay enterprise rates for a
principled tool, and the tool shouldn't force them to.

**Shape:** A `provider_config.yaml` in GeneralStaff root with
routing rules per agent role, overridable per project.

Example:

```yaml
providers:
  anthropic:
    api_key_env: ANTHROPIC_API_KEY
    models:
      opus: claude-opus-4-6
      sonnet: claude-sonnet-4-6
      haiku: claude-haiku-4-5

  openrouter:
    api_key_env: OPENROUTER_API_KEY
    models:
      qwen_code: qwen/qwen3-next-80b-a3b-instruct:free
      gemma_prose: google/gemma-4-31b-it:free

  gemini:
    api_key_env: GEMINI_API_KEY
    models:
      flash: gemini-2.5-flash

routing:
  planner: gemini.flash           # cheap, fast, good enough
  engineer: anthropic.opus        # quality matters most
  reviewer: openrouter.qwen_code  # judgment + free
  digest: gemini.flash            # summarization
  simulation: anthropic.sonnet    # reasoning over numerical data
```

Each agent role routes to a specific provider/model by default.
Users can override per project:

```yaml
projects:
  - id: catalogdna
    providers:
      engineer: anthropic.opus    # default
      reviewer: anthropic.sonnet  # override — catalogdna's
                                  # reviewer needs Claude-quality
                                  # scope-match judgment
```

**Why this is the structural answer to the Anthropic ToS
concern** (`RULE-RELAXATION-2026-04-15.md` §5.2): if the
expensive, subscription-ambiguous work goes to API-key BYOK
(Anthropic direct) and the cheap work goes to free tiers
(OpenRouter Qwen, Gemini Flash), users don't need to choose
between "spend money" and "maybe violate ToS." They get both.
The ToS question stops mattering.

**Why Phase 2, not Phase 1:** Phase 1 uses `claude-opus-4-6`
via Anthropic API key for all roles (Planner, Engineer,
Reviewer). One variable to debug. Phase 2 introduces the
routing abstraction and ships with sensible defaults. Phase 2+
lets users edit the routing to optimize cost.

**But the abstraction needs to be in place from day one even
if Phase 1 only uses Claude.** The `src/providers/` module and
the role → model lookup should exist in Phase 1 with exactly
one entry in each case. Phase 2 adds more entries. This
prevents a painful mid-project refactor when the feature
actually ships.

**Reference:** Ray's existing `~/.claude/CLAUDE.md` has detailed
routing rules for Gemini CLI, OpenRouter (Qwen3 Next 80B free,
Gemma 4 31B free), Ollama (Llama 3 local), and OpenCode.
GeneralStaff should inherit the same lean ordering:

- Gemini CLI for summaries and quick factual lookups
- OpenRouter Qwen3 Next 80B free for code-related delegation
- OpenRouter Gemma 4 31B free for prose/drafting
- Ollama for tiny instant tasks
- Claude for high-stakes architectural and security work

The rules live in one place (Ray's global config) and flow
through to GeneralStaff by convention.

### Tier taxonomy + implementation order (2026-04-16 update)

After the first live home-PC observation run (and the dispatcher
bug caught in it), the three provider tiers firm up as:

| Tier                              | Role                                | Provider                              | Why                                                                                                                                                                      |
| --------------------------------- | ----------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hot path — capability             | Engineer                            | Claude (Anthropic API) — for now      | Needs tool use, long context, strong coding. Swap later (aider-with-Qwen, opencode-with-Qwen) as a *separate* experiment.                                                |
| Structured I/O — judgment matters | Reviewer                            | OpenRouter Qwen3 Coder (paid, cheap)  | Pure prompt-in, JSON-out. Quality matters; Qwen3 Coder handles structured output cleanly. Fires every cycle — savings compound.                                          |
| Tiny tasks — quality-tolerant     | Digest / summary / classification   | Ollama (local — Llama 3 8B on home PC)| Zero rate limit, free, offline. Never on the hot path. Good enough for one-line summaries where taste is low-stakes.                                                     |

**Ollama-tier candidates in GeneralStaff specifically:**

- Digest narrative line (currently templated "N cycles, X verified,
  Y failed") — replace with a one-shot Ollama summary of what
  actually happened this session, grounded in the PROGRESS.jsonl.
- Per-cycle one-line PROGRESS description (what the bot did in
  human-readable form) — currently inferred from the commit
  message; could be a cleaner summary via Ollama.
- Backlog task classifier — if we ever add tagging (e.g. labeling
  each task as "test-coverage" / "feature" / "fix" / "refactor"),
  that's a 50-token classification problem. Ollama territory.

**Priority stack (cheapest-to-ship first):**

1. **Reviewer → OpenRouter Qwen3 Coder paid.** Single subprocess
   swap in `src/reviewer.ts`. Biggest per-cycle saving. Lowest
   risk — the reviewer's contract is already structured JSON
   validated by the dispatcher, so the provider doesn't need to
   "understand" anything new; it just needs to follow the prompt
   schema. ~1 session of work including a dual-run comparison
   (Claude vs Qwen on the same 10 cycles' diffs) to sanity-check
   that Qwen's verdicts match Claude's on a sample before we
   commit the swap.
2. **Ollama tier for summarization / classification.** Nice
   polish, no hot-path impact. Opt-in per site. Can ship
   incrementally — one Ollama task at a time (digest narrative
   first, because it's the most visible).
3. **Engineer → aider or opencode with Qwen.** Highest risk,
   highest reward. Deserves its own branch of dogfooding with
   a known-bad throwaway project (gamr, when it exists). Do
   NOT bundle with the reviewer swap — mixing experiments
   violates the one-variable-at-a-time principle that made
   the cycle-reset bug discoverable in the first place.

**Practical rollout context (2026-04-16):**

- Ray topped up OpenRouter with $10 that day — enough for
  thousands of reviewer calls at Qwen3 Coder 30B's $0.07/$0.27
  per-M pricing. The reviewer swap is safely inside budget
  even across multi-week overnight runs.
- Ollama is already installed on the home PC (Llama 3 8B). No
  new infrastructure required for tier 3 — just wiring.
- Engineer swap is blocked on agent-harness selection (aider vs
  opencode vs custom). That's a research task, not an
  implementation task. Not tonight's work.

---

## 3. Budget-per-Bot with Spend Guards (Phase 10+)

**Problem:** One of Polsia's pitched features is "bot with a
Meta Ads budget." It's a real differentiator if you can make
it safe. Polsia makes it *auto-enable-by-default*, which is
terrifying — the platform operator assumes liability for a bot
spending money on the user's behalf. Trustpilot reviews
document the predictable failure: users auto-committed to
obligations they couldn't walk back within 2 minutes of
signup. *"Within 2 minutes flat, it had entered me into
obligations that I couldn't back (automatically offered free
products to influencers). It took too long to find the OFF
switch."*

**Shape:** A `budget_config` field in projects.yaml that
defines:

- Per-bot budget caps (daily + monthly + total)
- Per-transaction approval threshold (above $X, require human
  approval before the bot commits)
- Rollback mechanism for reversible operations (credit card
  charges aren't reversible, so those go through the approval
  threshold instead)
- Full audit trail in PROGRESS.jsonl of every spend event with
  the prompt/context that led to it
- A "tripwire" list of operations ALWAYS blocked regardless of
  budget (e.g., "do not commit to multi-month contracts," "do
  not run crypto transactions," "do not spend on anything the
  user hasn't explicitly pre-authorized in a whitelist")

Implementation relies on the provider having a budget API (Meta
Ads has this, Stripe has this for user-side spend, many don't).
For providers without a spend API, the bot cannot touch that
channel at all. That's a feature, not a bug.

**When (if) this ships, the differentiator vs. Polsia is:**
Polsia auto-enables it by default; GeneralStaff requires
multiple explicit opt-ins, multiple layers of guards, and
makes spend-authority a principled per-project decision, not a
marketing selling point. The pitch reads *"budget authority is
powerful and dangerous. You have to ask for it in three places
before you get it. Here's why."*

**Why this is Phase 10+:** It's orthogonal to Phase 1-5 (which
is about code-writing agents). It also requires the creative
role plugin system from Phase 10 to exist first. Most
importantly, it requires the dispatcher to be battle-tested —
running a bot with a credit card on top of an untested
dispatcher is a recipe for exactly the Polsia failure mode we
differentiate against.

---

## 4. "Bring Your Own Imagination" Framing (README-level, applies now)

**Problem:** Polsia's marketing implicitly assumes everyone wants
a profitable SaaS startup. The product's failure mode is
homogenization — every Polsia-built company looks the same
because the underlying imagination is shallow. LLMs asked for
"a startup idea" return the mode of their training distribution,
which is generic SaaS.

**Shape:** GeneralStaff is neutral on project motivation. It
runs whatever you point it at. Research tool, art project,
satirical anti-startup, personal productivity stack, community
organizing tool, open-source contribution pipeline, a blog only
four people read, a fake company that exists to make a point —
all valid.

**The README framing:**

> *"Polsia assumes you want to build a SaaS. GeneralStaff
> doesn't care what you're building. Bring your own imagination;
> the tool runs the execution."*

Or, the one-line version: *"The tool is a GM. The imagination
is yours."*

This isn't a pivot from the current mission — it's making
explicit what the architecture already enables. The dispatcher
has no idea whether the project is commercial (there's no
revenue tracking, no monetization field in `projects.yaml`).
The README just needs to call this out as a deliberate choice.

**Why it matters:** it's the most honest thing an autonomous
tool can offer a creative person. It also pre-empts a category
of "but what do I build?" questions that Polsia's marketing
invites. GeneralStaff's answer is "whatever you were going to
build anyway. The execution phase isn't the bottleneck
anymore."

**Status:** applied to `README.md` in the 2026-04-15 evening
commit alongside this file. Section: "Who this is for."

**Related constraint:** Hard Rule #1 (no creative delegation
by default) still holds. Running a non-SaaS project doesn't
mean the bot writes the satire for you. The bot still does
correctness work (tests, infra, pipelines, bug grinding); the
user writes the creative part. The tool is neutral on
**motivation**, not on **quadrant**.

---

## 5. Retrogaze as Preferred Phase 3 Second Project

**Problem:** Phase 3 of the plan adds a second project to the
dispatcher to validate that the wrap pattern generalizes. The
original candidates were Retrogaze experimental (pipeline work)
and Sandkasten (non-game-logic work). Ray flagged 2026-04-15
evening that Retrogaze also has its own autonomous bot, similar
to catalogdna's.

**Shape:** Phase 3 = add Retrogaze as the second project.
(PIVOT-2026-04-15.md phased plan updated accordingly.)

**Why this is a better test case than Sandkasten:**

1. **It's a real SaaS with real users.** The stakes are higher
   than Sandkasten's experimental pipeline work, which means
   the verification gate gets tested against realistic pressure
   (real users noticing real bugs).
2. **It already has its own bot infrastructure.** That means
   Phase 3 tests "wrap a second mature bot" rather than
   testing "wrap the first mature bot AND also build a
   greenfield engineer_command from scratch." Two wraps first,
   greenfield (a project without its own bot) later in Phase
   4+.
3. **Different bot shape.** Retrogaze's bot is similar to
   catalogdna's but not identical. That's the right amount of
   variance to surface generalizability issues in the
   `engineer_command` / `verification_command` abstractions.
   Two data points is better than one.
4. **Ray has stakes in Retrogaze.** Any work GeneralStaff does
   on Retrogaze is valuable independently of the GeneralStaff
   experiment. Dogfood-for-real-value, not dogfood-for-testing.

**What Phase 3 still needs to discover about Retrogaze:**

- Retrogaze's bot launch mechanism (is it `run_bot.sh`
  equivalent? Different shape?)
- Retrogaze's verification command (tests, build, lint)
- Retrogaze's hands-off list (IP boundaries, infra files)
- Retrogaze's work-detection mechanism (does it have a
  `bot_tasks.md` equivalent, or a different format?)
- Retrogaze's concurrency-detection signals (are they the same
  three as catalogdna, or different?)

**Action for Phase 3:** open a fresh session in Retrogaze's
directory, read its bot infrastructure, produce a
`retrogaze-integration-plan.md` equivalent before touching
GeneralStaff's code. Treat it as a miniature version of the
catalogdna deep-dive that produced `PHASE-1-PLAN`.

**Why this matters for the open-source story:** the more
different the two projects are (catalogdna = musician analysis
pipeline with its own worktree / heartbeat / Phase A-B protocol,
Retrogaze = a different SaaS with a different bot shape), the
stronger the claim that GeneralStaff actually generalizes. A
soft launch to 5 external users is credible after "it works on
catalogdna + Retrogaze" in a way it isn't after "it works on
catalogdna only."

---

## 6. Creative Mode / Second-Brain Retrieval Plugin (Phase 4+)

**Captured:** 2026-04-17 early morning, during the Ollama
reviewer practice run. Ray raised this as an expansion of the
"creative agents are opt-in plugins" clause of Hard Rule 1.

**Problem.** Rule 1 says *"no creative work delegation by
default. Bots get correctness work; users keep taste work.
Creative agents are opt-in plugins with explicit warnings."*
That's a defensible default, but the "explicit warnings" clause
is doing a lot of work. What would a principled creative-mode
plugin actually look like — one that doesn't collapse into
confident slop the moment it gets turned on?

The naive path is to turn the bot loose on generation tasks
("draft a song", "write a game manual") with a disclaimer. That
inverts the industriousness/judgment relationship in exactly
the wrong way — the bot is most industrious and least judged
when doing creative work, which is where slop is worst.

**The key reframing.** A creative-mode plugin should be
**retrieval, not generation**. The bot indexes the user's own
corpus and answers queries that *cite prior-user thoughts*.
Taste decisions still belong to the user; the bot just makes
the user's own prior output faster to access than manual search.

Concrete distinction:

- *"Find every time I've talked about asymmetric objectives
  in the wargame manuals"* — retrieval, correctness work. Did
  the search return the right passages? Measurable, bounded,
  safe to delegate.
- *"Suggest a new asymmetric-objective mechanic given my prior
  designs"* — generation, taste work. Out of scope. The user
  reads the retrieved passages and decides what's next.

The retrieval/generation line is the same one Rule 1 already
draws between correctness and taste; it just extends into a
new domain (the user's own creative archive).

**Shape.** `generalstaff vault` subcommand as an opt-in
plugin (per Rule 1's "creative agents are opt-in plugins" clause).
Three phases of implementation:

1. **Ingest.** Heterogeneous corpus support: Ray's 400+ song
   catalog (audio metadata, lyrics, self-authored influence
   notes), pre-AI-era wargame manuals (Markdown conversions of
   paper documents), Facebook status exports, email archives,
   maybe future photo metadata / voice memo transcripts. Each
   source type needs a tailored parser + chunker.
2. **Index.** Embeddings + metadata (date, source, tags).
   Citation-first retrieval — every returned passage comes with
   provenance. No "the model learned it" — only "here's where
   you wrote it."
3. **Query.** Natural-language questions answered with cited
   excerpts. Explicit refusal to generate *new* creative content
   in the same call — a hard architectural boundary, not a soft
   prompt instruction. The vault plugin never writes; it only
   retrieves.

**Why this fits Rule 1.** The retrieval-only invariant is
*already how Rule 1 thinks about creative work*. "Creative
agents are opt-in plugins with explicit warnings" — the vault
plugin is explicitly opt-in, explicitly advisory, explicitly
retrieval-only. The warning is literally the retrieval/generation
line: *"this plugin shows you what you've thought before; you
still decide what to do next."* That's a warning a user can
actually internalize, unlike the vague "AI might hallucinate"
warning most creative tools ship with.

**Research pointers for a future design session.** Karpathy has
been doing recent work in the second-brain / personal-archive
retrieval space, and a cluster of open-source repos has emerged
around this problem shape. Before designing the vault plugin, a
survey pass should answer: which existing tools handle
heterogeneous corpora (audio metadata + PDFs + social exports
+ emails) in one index? Which handle citation-first retrieval
vs. the more common "answer + footnote" pattern? What eval
harnesses exist for measuring "did retrieval return the right
sources" as a correctness metric? The right default may be to
wrap an existing tool rather than build from scratch —
consistent with the "prefer libraries" pattern in §1.

**Near-term dogfooding experiment: README drafting.** A smaller,
tractable version of the same idea is on the table right now:
have the bot read the `matiassingers/awesome-readme` reference
+ GeneralStaff's existing docs and produce a *structural
proposal* for the README (which sections to include, in what
order, with what anchors) — NOT the final prose. User picks
voice, positioning, and tone. This is a retrieval/structuring
task dressed up as a creative one; the bot does the enumeration
and surveying (correctness), the user does the voice (taste).

Running this dogfood experiment would also generate a useful
data point for the larger vault plugin design: how much value
does "structural proposal from a checklist source" actually add
for a user who could also just read the checklist themselves?
If the answer is "not much," that's evidence that retrieval
alone isn't enough — we also need good *synthesis* of retrieved
material, which is a harder design problem.

**Phase.** Full vault plugin is Phase 4+ (after Phase 1 MVP
ships, after second-project validation in Phase 3, after
provider routing stabilizes in Phase 2). README dogfooding
could happen any time — it's a single bot task with a bounded
output.

### Wiki-layer reconcile (added 2026-04-18)

A parallel claude session bootstrapped Ray's first concrete
vault project (private, named `raybrain`) and surfaced a real
design tension that this section's original 2026-04-17 capture
didn't address: **Karpathy's three-layer LLM-wiki pattern has
the LLM write synthesized pages at ingest time**, which bumps
against this section's "plugin never writes" invariant.

The reconcile: **never writes in the query path; ingest-time
compile is allowed.** Query-time generation remains forbidden
(that's the slop floor). Ingest-time synthesis — building
human-readable wiki pages over the raw corpus — is permitted
provided four constraints hold, all of which keep the
synthesis layer subordinate to the user rather than
substitutive:

1. **Citation floor.** Every paragraph in a wiki page links
   back to specific raw-corpus passages. No claim without an
   anchor. The wiki page is a *view* of the corpus, not a
   *replacement* for it. A page that "summarizes" without
   citing is a hallucination by definition.
2. **Idempotent regeneration.** Pages are reproducible from
   the raw corpus. Deleting a page and re-running ingest
   produces the same (or documented-as-different) page. No
   hidden state in the synthesis layer; the raw corpus
   remains the single source of truth.
3. **User-editable, user-rejectable.** Pages live in plain
   markdown the user can edit by hand. If the user edits a
   page, the next ingest respects the edit (does not
   clobber). The user is still the source of truth on
   synthesis quality.
4. **Visible at query time alongside raw sources.** Retrieval
   surfaces both the wiki-page synthesis AND the raw passages
   it links to, so the user sees the synthesis layer working
   alongside the citations rather than instead of them. A
   query that returns *only* a synthesized page is a query
   that should also have returned its citation set; if it
   didn't, the wiki page itself is suspect.

With those four constraints, ingest-time synthesis stays
inside Hard Rule #1's "creative work stays with the user"
spirit — the user can always see, edit, or discard what the
LLM compiled. The synthesis layer is an index over the
corpus that happens to be human-readable text, not a
parallel creative output.

**Why this matters as architecture, not just policy.** The
four constraints are testable invariants the vault plugin
can enforce structurally:
- Citation floor → schema requirement on wiki page format
  (every paragraph must contain at least one `[ref:...]`
  marker; ingest fails if the LLM emits a paragraph without
  one).
- Idempotent regeneration → ingest is a pure function of
  raw corpus + config + page-edit overlay; ingest tests can
  assert byte-for-byte stability across runs (modulo the
  edit overlay).
- User-editable → page edits captured as a separate
  `<page>.user-edits.md` overlay that ingest reads but
  doesn't modify.
- Query-time co-visibility → query API always returns
  `(synthesized_page?, raw_citations[])` as a tuple; no
  endpoint returns one without the other.

Because the constraints are testable, they can land as part
of the vault plugin's verification gate. A plugin run that
violates any of them fails verification just like a code
change that breaks tests — which lets gs-style autonomous
correctness work apply to the vault's ingest pipeline
itself.

**Cross-reference.** This addendum was triggered by the
2026-04-18 morning bootstrap of `raybrain` (Ray's private
second-brain project — corpus includes music, Facebook
exports, pre-AI-era wargame manuals). The raybrain repo's
own design docs reference back to this section for the
architectural rationale; the project-specific design choices
(corpus loaders, eval golden set, raybrain-specific schema
extensions) live in raybrain's repo and stay private.

**Open questions.**

- Does "retrieval only" survive contact with real usage? Users
  will ask for synthesis ("summarize the three times I wrote
  about X"). Summarization is closer to retrieval than
  generation, but the line gets fuzzy fast. The plugin needs a
  principled stance on what counts as the retrieval side.
- Privacy model? A user's full email archive and FB history is
  extraordinarily sensitive. The vault must be local-first
  (Hard Rule 10) with no cloud egress, and the opt-in flow
  needs to make this absolutely clear.
- How does the vault interact with the reviewer? Presumably
  the vault plugin is its own runtime concern, not a reviewer
  step. But if a future creative-mode bot ever did generate,
  a vault-aware reviewer that checks "was the output grounded
  in the user's own corpus?" becomes a plausible verification
  layer.

---

## 7. Live Fleet Viewer + Remote Access (Phase 5+)

**Captured:** 2026-04-17 morning, during the Ollama practice run.
Ray flagged two distinct-but-related user-interface ideas. Both
depend on the Phase 4 local dashboard shipping first — premature
to design either now, but worth capturing the framing.

### (a) Live fleet viewer — Kriegspiel campaign-map as animation

UI-VISION-2026-04-15.md already establishes the static aesthetic
(lithograph paper, brass fittings, Prussian palette, project pins
on a stylized campaign map). This extension adds **motion**: the
campaign map becomes alive with tiny figures representing each
registered project's bot, showing current state in real time.

Reference point: **pablodelucca/pixel-agents** on GitHub — a
pixel-style real-time visualization of AI agents at work. The
goal isn't to copy the pixel-agents visual style (that's modern
8-bit video-game; GeneralStaff's style is 19th-century
lithograph) but to copy the **information density + motion
pattern**: each bot is a visible figure, its current activity is
legible at a glance, status changes animate smoothly.

**Shape.**

- Each registered project occupies a sector on the campaign map
- A tiny figure moves between sectors representing the currently-
  running bot
- The figure's pose/color indicates cycle phase: engineering
  (writing dispatches), verifying (consulting the staff officer),
  under review (awaiting the reviewer's verdict)
- Verified cycles produce a brief "advance" animation; failed
  cycles produce a "retreat" animation
- Completed tasks accumulate as flags planted on sectors
- STOP file dropped → everyone stands down visibly

**Why this isn't kitschy.** The military-staff visual language is
already this project's brand per UI-VISION. Animating it isn't
dressing up a generic dashboard; it's making the *existing*
metaphor more vivid. The Kriegspiel table at the Kriegsakademie
had literal pieces being moved by duty officers — the animation
is showing what the metaphor has always been.

**Risk.** Over-investment in visualization before the product
works is a classic Phase-5 trap. Guardrail: the animation must
add zero latency to actual bot throughput (runs in a separate
process or read-only tail of PROGRESS.jsonl) and must be
optional (`--no-ui` or just not launching the viewer). The bot
never waits on the UI.

### (b) Remote access from a second device

**Problem.** If the user runs GeneralStaff on a home PC, they
want to check on it — and optionally direct it — from a work
computer or phone during the day. Right now there's no way; the
CLI is terminal-only on the home machine.

**Shape.** The Phase 4 local dashboard already plans a browser
interface running on the home PC. The missing piece is *reaching
that dashboard from a different device* without exposing it to
the public internet.

**Recommended default: Tailscale.** Peer-to-peer VPN mesh, free
tier covers personal use, single-click install on both machines.
The work PC (or phone) joins the same tailnet as the home PC
and reaches `http://home-pc.tail1234.ts.net:8080` (or whatever
port the dashboard serves) directly. No public exposure, no
hosted middleman, no open firewall ports on the home router.
This is compatible with Hard Rule 10 (local-first, no SaaS
middleman — the Tailscale control plane is out-of-band for
auth/discovery only; the actual dashboard traffic is P2P).

**Alternatives (all more work for the user).**

- SSH tunnel + port forwarding — requires CLI comfort
- Cloudflare Tunnel — exposes over their edge network, public by
  default unless you layer Cloudflare Access auth
- Self-hosted WireGuard — most private but most setup burden
- Local-network-only access — works only on the same WiFi,
  doesn't help with work-from-anywhere

Tailscale is the right default for a non-programmer user. If the
installer were ever automated (`generalstaff setup-remote` that
walks through `tailscale up` on both ends), it would be a strong
differentiator vs. Polsia (which is cloud-only) and vs. most
self-hosted alternatives (which assume the user can configure
VPNs).

**Authentication model.** The dashboard needs some protection
even inside the tailnet — the user might share the tailnet with
family, roommates, etc. A simple shared-secret auth ("enter the
key printed by `generalstaff key show` on the home machine") is
probably sufficient for Phase 5, with real OAuth / device-bound
creds as a Phase 6+ upgrade.

**Why both of these are Phase 5+.** Both depend on the Phase 4
local web dashboard shipping in a usable state. Designing the
animation layer or the remote-access layer before the static
dashboard exists is solving the wrong problem. The right order
is: functional dashboard → theming (UI-VISION) → motion (§7a) →
remote access (§7b).

---

## 8. Multi-Bot Fleet + Inter-Bot Communication (Phase 3+)

**Captured:** 2026-04-17 morning. Ray raised parallel bots as a
natural extension of the Phase 3 second-project work, and added
a specific question: should bots be able to communicate with one
another, possibly via MCP?

**Status.** Hard Rule 3 already flags this direction — *"Sequential
cycles for MVP. Parallel worktrees come later."* §8 is the design
space for what "later" looks like.

### What "multiple bots on different tracks" could mean

Three meaningfully different patterns, each with its own tradeoffs:

1. **Projects-parallel.** One bot on generalstaff, a second on
   gamr, simultaneously. Natural fit for the existing architecture
   (worktrees are already per-project, `bot/work` branches are
   per-project, PROGRESS.jsonl is per-project). Main blockers:
   `fleet_state.json` read-modify-write contention during picker
   decisions, auto-merge to master needs serialization (two cycles
   finishing within seconds of each other both try to merge), and
   the picker itself goes from "pick one" to "assign N concurrent."
   This is the lowest-friction next step and pairs naturally with
   Phase 3's second-project validation.

2. **Tracks-within-a-project.** Separate "bug fixes" / "new
   features" / "refactors" lanes inside a single project, each with
   its own task subset and its own worker. Requires splitting
   `tasks.json` into tracks (or filtering by a `track` field on
   each task) and a pool-of-workers abstraction to claim and
   release tasks. More complex than projects-parallel because it
   introduces intra-project coordination that doesn't exist today
   (e.g., two bots want to touch the same file). Useful if a
   single project becomes large enough that the 10-cycles-per-
   project-per-session cap becomes the bottleneck.

3. **Competitive implementations of the same task.** N bots race
   on gs-XYZ independently; the reviewer picks the strongest diff
   and discards the others. Highest LLM spend (N× per task) and
   the pattern really only works when reviewer quality is already
   high (otherwise "strongest diff" is noise). Probably a research
   mode, not a default — potentially useful during reviewer
   calibration or for high-stakes tasks where the user wants
   redundant attempts.

The right incremental path is almost certainly (1) → optionally
(2) → maybe (3) as a later experiment. Each transition multiplies
the coordination surface area; premature jumps introduce emergent
bugs that are hard to attribute.

### Inter-bot communication

Once bots run in parallel, the next question is whether they can
signal each other. Two architectural options:

**(a) Peer-to-peer messaging.** Bots write messages directly into
a shared inbox (`state/messages.jsonl`, or a SQLite queue, or an
in-process MCP server) and read each other's output. Maximum
flexibility — each bot can broadcast handoffs, warnings, or
results to anyone. Maximum footgun — races between "bot A decides
to work on X" and "bot B's message saying X is already done"
arriving late. Emergent bad behavior if the signaling protocol
isn't carefully designed.

**(b) Dispatcher-mediated.** Bots don't talk to each other
directly; they all talk to the dispatcher, which acts as a
central coordinator. The dispatcher owns task assignment, merge
serialization, and whatever cross-bot state matters (who's
working on what, who finished, who's blocked on whom). Equivalent
to a multi-worker job-queue pattern — well-understood, minimal
emergent behavior, easy to audit. The bots are simpler (no need
to model peer state); the dispatcher is slightly more complex.

(b) is almost certainly the right default. Direct peer messaging
is the kind of feature that looks elegant in a design doc and
produces weird bugs in production.

**The MCP angle.** Claude Code is an MCP client by default. If
the GeneralStaff dispatcher exposes an **MCP server** with tools
like `claim_task`, `report_progress`, `release_task`, `signal_peer`,
the bots can use those tools natively without any extra glue
code. The dispatcher becomes a standard MCP server; each bot's
`claude -p` session connects to it the same way it connects to
any other MCP server. This is a natural home for (b): the MCP
server *is* the dispatcher's public API, and the bots are just
clients.

Advantages of an MCP-based dispatcher:

- Zero glue code for bots — MCP integration is already
  first-class in Claude Code
- The same MCP server could be reached from a user-facing
  dashboard (§7a) for fleet visualization without double-coding
  the API
- Testable with any MCP client (inspector, custom scripts)
- Versionable — MCP tool signatures are the contract

Open questions for this direction:

- Does a locally-running MCP server conflict with Hard Rule 2
  (file-based SSOT)? Probably not — the MCP server is a *process*
  that reads/writes files as before; it's just a coordination
  layer on top of the existing file-based state, not a replacement.
- Are there existing agent-fleet / multi-agent-coordination repos
  (MCP-based or otherwise) worth surveying before designing this
  from scratch? Ray flagged **desplega-ai/agent-swarm** as one to
  study. Survey notes on that repo are in §8a below; Karpathy's
  recent work (flagged in §6) is still a separate open item.
- What's the right level of observability into fleet state? The
  dispatcher should probably write a fleet-level PROGRESS entry
  for every cross-bot event (task claimed, task released, merge
  serialized, etc.), feeding both the audit log and §7a's live
  viewer.

### Risks to flag

- **Parallel = Npx the spend** for paid reviewers. BYOK users
  running 3 bots in parallel with OpenRouter pay 3× the reviewer
  cost. The free Ollama path is the clean answer; the `.bat`
  wrapper should make this explicit (e.g., warn when launching
  parallel mode with a paid provider).
- **The hands-off gate is currently per-cycle, not cross-bot.**
  Two bots running in parallel could both try to modify
  `src/reviewer.ts` and neither would know. The verification
  gate catches it at cycle close, but the work was already done.
  The dispatcher could preemptively reject overlapping task
  assignments using the hands-off pattern set.
- **Auto-merge ordering matters.** If bot A's merge conflicts
  with bot B's changes to master, what happens? Options: merge
  in completion order (simplest, ignores conflicts), merge in
  priority order (user-configurable), or reject the later one
  and require human resolution (safest). The dispatcher owns
  this decision.
- **A single crashed bot should not take down the fleet.** The
  dispatcher needs health checks and the ability to release a
  claim if a worker goes silent for too long.

### Phase

Phase 3+ for projects-parallel (the natural coupling with the
second-project validation). Phase 4+ for tracks-within-project
and inter-bot communication. Phase 5+ or later for competitive
mode. Don't design the MCP-dispatcher API until projects-parallel
is actually running and we know what tools the bots wish they
had — premature API design in a distributed system is a
category of slop worth avoiding.

### 8a. Survey: desplega-ai/agent-swarm

**Captured:** 2026-04-17 morning, via WebFetch of the repo's README.

Agent-swarm is a production multi-agent orchestration system that
has independently arrived at almost the same design this document
argues for. Worth capturing the points of agreement and the points
of divergence so a future Phase 3+ design session can steal the
good ideas and make informed choices on the rest.

**Points of agreement (validates the §8 direction):**

- **Centralized lead/worker model, not peer-to-peer.** Their
  "lead agent" is functionally equivalent to the dispatcher-
  mediated pattern (b) recommended above. One agent receives
  tasks, breaks them down, delegates to workers, tracks progress.
- **MCP as the coordination surface.** They expose an "MCP API
  server" that manages agent coordination; workers connect to it.
  This is the same MCP angle proposed in §8. Independent
  convergence is a strong signal this is the right shape.
- **Queue-based task assignment with dependencies.** Tasks enter
  a priority queue; the lead plans and assigns. Supports pause/
  resume across deployments. GeneralStaff's current `tasks.json`
  is a simpler version of the same idea; the priority queue with
  explicit dependencies is a Phase 4+ upgrade worth keeping in
  mind.

**Points of divergence (where GeneralStaff stays different by
choice, not oversight):**

- **Docker container isolation for workers.** Agent-swarm runs
  each worker in a Docker container. GeneralStaff uses git
  worktrees instead (per-cycle isolation, no containerization
  overhead). The worktree approach is lighter weight and avoids
  a Docker dependency for local-first self-hosting. Revisit only
  if cross-project file contention becomes a real problem.
- **SQLite backs the coordination DB.** Agent-swarm persists
  coordination state in SQLite. GeneralStaff's Hard Rule 2 says
  file-based SSOT (JSONL + JSON configs). These are defensible
  for different reasons: SQLite for transactional consistency;
  JSONL for grep-ability and simple audit trails. The MCP layer
  could sit atop either. Phase 3+ design should pick deliberately,
  not by default.
- **A lead agent breaks tasks down.** Agent-swarm's lead agent
  plans and decomposes work. GeneralStaff's Hard Rule 1 keeps
  task decomposition with the user (it's taste work, not
  correctness work — a lead agent breaking down tasks is exactly
  the "confident creative slop" risk Rule 1 guards against).
  This is a real philosophical divergence, not a gap — the whole
  GeneralStaff framing is that the user is the lead officer,
  the bots are the general staff.

**Novel ideas from agent-swarm worth considering:**

1. **Persistent agent identity files** — they keep `SOUL.md`,
   `IDENTITY.md`, `TOOLS.md`, `CLAUDE.md` per agent, evolving
   across sessions. GeneralStaff already has per-project
   `CLAUDE.md`; the `SOUL.md` / `IDENTITY.md` split is an
   interesting layering that could formalize "what this agent
   *is* vs. what this project *is*." Might be Phase 4+ in
   GeneralStaff when per-bot specialization shows up.
2. **Compounding memory with task embeddings.** Automatic
   session summaries and task embeddings indexed for future
   context. GeneralStaff's PROGRESS.jsonl is the raw audit
   trail; an indexed-summary layer on top is a reasonable
   Phase 4+ observability win (and ties nicely to §6's vault
   plugin — the same embedding infrastructure could index the
   bot's own work history and the user's creative corpus).
3. **Skill-scope resolution** — `agent → swarm → global`.
   Equivalent to the scope inheritance Ray already uses in his
   `~/.claude/CLAUDE.md` → project `CLAUDE.md` overrides.
   Applied to bot skills (not just prompts), this is a clean
   way to ship "standard bot behaviors" as a library that
   users can override per project.
4. **DAG-based human-in-the-loop workflows with approval nodes
   and structured I/O schemas.** Most of GeneralStaff's
   approval points are binary (merge / don't merge, STOP file).
   A richer approval graph with typed schemas per node is
   overkill for Phase 1 but could matter once there are
   multiple project owners using the same fleet.

**Immediate takeaway.** The agent-swarm survey doesn't change
the Phase 3+ path outlined in §8 — it confirms it. The specific
novel abstractions (identity layering, indexed summaries, skill
scoping) are good candidates for Phase 4+ follow-on tasks once
the basic multi-bot dispatcher is running.

---

## 9. Autobot Bootstrap / Onboarding Wizard (Phase 3)

**Captured:** 2026-04-17 morning, after Ray proposed that
GeneralStaff should be able to build/design an autobot for a
project that currently has none (using gamr or one of his
existing repos as the example later).

**Framing shift.** This reframes Phase 3 itself. The current
Phase-3 plan is "add a second project to prove GS generalizes
beyond catalogdna." A more interesting framing is **"does
GS onboard a fresh project in one command"** — the second
project isn't just a generality test, it's the proving ground
for the onboarding flow. The design target becomes:

```
$ generalstaff bootstrap --project=/path/to/gamr
Analyzing... detected TypeScript + vitest + git
Proposal written to /path/to/gamr/.generalstaff-proposal/
  - CLAUDE-AUTONOMOUS.md (draft autobot contract)
  - tasks.json (seeded with 5 starter correctness tasks)
  - hands_off.yaml (7 pattern proposals with rationale)
  - verify_command.sh (inferred: npm test && tsc --noEmit)
  - engineer_command.sh (standard claude -p invocation)
  - README-PROPOSAL.md (what each file is, what to edit)
Review the proposal, move files into place, then:
  generalstaff register --project=/path/to/gamr
```

**Why this fits Rule 1.** Bootstrapping IS correctness work
when scoped right:

- *Detecting* the project's language, test framework, and
  build tools → correctness (reading file markers, running
  `ls`, parsing package.json — fully bounded)
- *Proposing* a hands_off list → correctness (pattern-match
  the file tree, suggest defensible defaults)
- *Seeding* starter tasks from inferred gaps → borderline,
  but the scaffold ones can be safely generic ("add test for
  module X", "document function Y") without inventing
  product direction
- *Writing the CLAUDE-AUTONOMOUS.md tone/voice* → taste work,
  stays with user (the bot drafts structure + placeholders,
  user fills in voice)

Same retrieval-vs-generation line as §6: the bot outlines
and proposes; the user decides voice, scope, and whether
the proposal becomes the final config.

**Concrete outputs.** The bootstrap command writes files to
a **staging directory** (`.generalstaff-proposal/` inside the
target project) rather than modifying the repo. This enforces
the "propose, don't impose" pattern:

1. `CLAUDE-AUTONOMOUS.md` — project-specific autobot contract
   skeleton with sections for Phase-A/B behavior, constraints,
   and scope discipline. Placeholders marked `<FILL IN>`.
2. `tasks.json` — 3-5 starter tasks inferred from repo state
   (missing tests, undocumented modules, open TODOs in code
   comments, stale dependencies). Each task scoped small.
3. `hands_off.yaml` — pattern proposals with one-line rationale
   per pattern ("`node_modules/**` — generated, never edit by
   bot"; "`src/generated/**` — codegen output"; etc.). User
   reviews; Rule 5 requires non-empty before registration.
4. `verify_command.sh` — inferred from test-framework detection
   (package.json scripts, Cargo.toml's test aliases, etc.).
5. `engineer_command.sh` — standard `claude -p` invocation
   pointed at the project's CLAUDE-AUTONOMOUS.md.
6. `README-PROPOSAL.md` — what each file is, what to edit, what
   to keep, how to register with `generalstaff register` once
   the user is happy with the proposal.

**What the bootstrap deliberately doesn't do.**

- **Never writes to the target repo root** without the user
  moving files manually. The staging dir is throwaway.
- **Never registers the project** automatically. User runs
  `generalstaff register` explicitly after reviewing.
- **Never invents product direction.** The starter tasks are
  correctness-type tasks that any codebase can use ("add tests
  for uncovered module X"), not "implement feature Y."
- **Never infers the autobot's *name* or *personality*.** Those
  are taste decisions. The CLAUDE-AUTONOMOUS.md has
  `<PROJECT_NAME>` placeholders the user fills.

**Detection heuristics (first pass).** The detection layer
reads:

- `package.json` → Node/TypeScript, npm scripts for test/lint
- `Cargo.toml` → Rust, `cargo test`
- `pyproject.toml` / `setup.py` → Python, pytest/ruff
- `go.mod` → Go, `go test ./...`
- `pom.xml` / `build.gradle` → Java/Kotlin
- Absence of any of the above → print a message asking the
  user to specify the verify command manually

None of this is novel — any decent CI generator does it.
GeneralStaff just ties detection to a specifically-shaped
proposal output.

**Why this is Phase 3 (not later).** Phase 3 was always "prove
generality with a second project." The bootstrap feature turns
that into "prove generality AND onboarding velocity in one
move." gamr is the perfect first target — deliberately-mediocre
idea (per the test-project constraints doc), lets us measure
bootstrap behavior without product-validity as a confounder.

If the gamr bootstrap produces a proposal that survives a
5-minute user review without massive edits, that's a stronger
generality signal than just "GS ran cycles on a second repo."

**Open questions.**

- Should the bootstrap also propose a `cycle_budget_minutes`?
  Probably yes, with a very conservative default (30 min) and a
  note suggesting the user tune after a few cycles.
- Should the bootstrap install anything? Probably no — anything
  installable should be explicit user action. The proposal is a
  doc, not a side effect.
- How does this interact with §8's multi-project parallel?
  Cleanly — bootstrap creates one project at a time; parallel
  dispatch sees them the same way regardless of origin.
- What about existing autobot projects (catalogdna) that
  already have a non-GS-shaped autobot? The bootstrap would be
  the wrong tool — catalogdna keeps its existing protocol,
  GeneralStaff just wraps it per the current per-project
  relationship (see CLAUDE.md §"Critical: the per-project
  relationship"). Bootstrap is for *new* autobots, not
  retrofitting existing ones.

---

## 10. Non-Programmer Distribution + Use Cases (Phase 5+)

**Captured:** 2026-04-17 morning. Ray noted that GS should be
usable by "average people" running simple side hustles — the
concrete persona he named is a music teacher running a lesson
gig. Distribution needs to catch up to that reach, with an
install package and a manual/wiki for non-programmers.

This section pairs with the VOICE.md human-livability thesis:
the tool only makes work more livable *for more people* if more
people can actually install and use it. Reach is part of the
product.

### The distribution gap

Current prerequisites: bun installed, git installed, Claude CLI
installed, an API key or Ollama, command-line comfort, and
willingness to edit `projects.yaml` by hand. That's a developer
starter kit. A music teacher, freelance writer, or small-ecommerce
operator has zero of those.

Every barrier in that list is a person who can't use the tool.
Every person who can't use the tool is someone the human-
livability thesis doesn't reach.

### The install-package shape

Phase 4's planned Tauri UI is the natural distribution vehicle.
Tauri bundles a native shell around a web UI and ships as a
one-click installer per platform (`.msi` on Windows, `.dmg` on
Mac, `.AppImage`/`.deb` on Linux). The installer should bundle
everything a non-programmer can't reasonably install themselves:

- **Bun runtime** — embedded in the app, not a system dependency
- **The GS source** — compiled or bundled, not cloned from git
- **Ollama check** — optional install flow if the user wants
  the free-local-reviewer path
- **Claude / OpenRouter key setup UI** — guided entry, not env
  vars; stored locally (per Rule 10), never hosted
- **First-run `generalstaff init` wizard** — walks through
  registering the first project without touching YAML

The user never sees a terminal unless they want to. They never
edit a config file by hand unless they want to. The power-user
CLI stays available alongside; nothing about the UI replaces
the programmer workflow.

### The manual / wiki

Non-programmer docs need to be a different artifact from the
developer docs. Two distinct surfaces, probably both living in
the repo:

- **Developer docs** (what we have now): CLAUDE.md, DESIGN.md,
  the PHASE-* plans, VOICE.md, FUTURE-DIRECTIONS. Audience
  assumed to be programmers auditing the tool or contributing.
- **User manual** (new, Phase 5+): scenario-driven, plain-
  language, ships alongside the install package. Structure
  should be "I want to do X — here's the recipe" rather than
  "here's the CLI reference."

Sample chapters the user manual might include:

- *Getting started* — install, first project, first cycle
- *"I run music lessons"* — scheduling, invoicing, website
  updates via GS
- *"I sell handmade goods"* — inventory sheets, listing
  maintenance, customer auto-replies
- *"I do freelance writing"* — editorial calendar, submission
  tracking, invoice follow-ups
- *Safety* — plain-language version of Hard Rules (what the
  bot will and won't do)
- *When something goes wrong* — how to read the digest, how to
  STOP the bot, how to roll back

### The Rule-1 boundary still applies

Side-hustle use cases look creative-adjacent, but the correct
application of GS to those cases is still correctness work:

- GS good at: maintaining a lesson-tracking spreadsheet's
  schema, updating website copy when prices change, generating
  invoice PDFs from structured data, keeping a social-media-
  post schedule file valid, running backup scripts.
- GS bad at: writing lesson plans, drafting teaching
  philosophies, designing product descriptions, picking what
  songs to teach. That's taste work; the teacher keeps it.

The user manual should be explicit about this split. The
temptation, once a user sees GS work, will be to delegate
creative decisions. The manual should push back: *"GS makes
the mechanical work of running your business disappear; it
deliberately doesn't touch the creative work that is your
business."* That's the human-livability frame restated for
the non-programmer reader.

### The onboarding-wizard coupling

§9's `generalstaff bootstrap` command becomes much more
valuable when the user population includes non-programmers,
because the bootstrap output is the first thing a non-programmer
would otherwise have to write from scratch. In a world with the
bootstrap + Tauri installer + wizard, a music teacher's
onboarding is:

1. Download + install GS (one click)
2. Point it at a folder with their business's files (drag-drop)
3. Review the bootstrap proposal (plain language, not YAML)
4. Approve → GS starts running

Three minutes, zero command-line exposure, and the user still
owns all the rules, files, and decisions. That is the product.

### Phase

Phase 5+ for the full install package, user manual, and
non-programmer onboarding flow. Depends on:

- Phase 4 Tauri UI shipping (the installer vehicle)
- §9 bootstrap command existing (the onboarding wizard backend)
- §7 remote-access pattern (so work-PC and home-PC are both
  reachable by the non-programmer user who owns them)

Before shipping non-programmer distribution, the dogfooding
evidence from §Dogfooding (see VOICE.md) needs to be strong
enough that "download and run this on your small business's
files" is a claim the README can make without hedging. That
probably means: a clean run of at least a few months on the
GS repo itself, visible PROGRESS.jsonl, zero user-facing
surprises from the verification gate.

### Why this matters for the voice

The non-programmer distribution story is the **concrete test**
of the human-livability thesis. If the tool's reach stops at
programmers, it's a better open-source alternative to Polsia
but it's not a labor-economics intervention. If a music teacher
can install it, use it, and get 5 hours a week back from
admin work, that's the thesis in practice — the kind of
specific, verifiable claim a README can lead with.

The README can eventually carry a line like *"If you can
install a printer driver, you can run GeneralStaff."* That
sentence is a product commitment, not marketing — and shipping
Phase 5+ means honoring it.

---

## Market observation: why no one else has built this

Captured for reference, not as a design decision. Reasons it's
surprising Polsia doesn't already have an open-source
competitor four months after launch:

1. **Polsia is new.** December 15, 2025 launch. Four months
   old as of 2026-04-15. Open-source typically lags commercial
   by 12-24 months on established patterns and longer on novel
   ones.
2. **Most OSS devs don't fork VC-funded startups.** The
   cultural default is "build what excites you," not "build
   the open version of this thing the VCs are funding." The
   existence of the opportunity is invisible to the people in
   position to take it.
3. **The verification-gate insight requires specific prior
   experience.** You have to have run autonomous bots that
   lied about their work to viscerally understand why
   verification-first matters. Ray has this from catalogdna;
   most OSS devs don't.
4. **The people who could build it are mostly building their
   own Polsia clones for VC money.** Silicon Valley optimizes
   for "fastest path to a demo that impresses investors,"
   which is opposite of "verification-first." The intersection
   "solo dev with game design instincts + anti-lock-in politics
   + verification-first discipline + recent autonomous bot
   experience + willing to do it in open source" is narrow.
5. **The window is now.** Polsia hasn't had time to build a
   real moat. An open-source competitor launched within 2-3
   months has a fighting chance; launched in 12 months it's
   fighting uphill.

None of this is a "you must ship fast" lecture — the Phase 1
through 7 plan is fine. It's context for why the opportunity
exists at all and why the earlier-soft-launch recommendation
from earlier in the 2026-04-15 session is worth taking
seriously.

---

## What these ideas collectively say about GeneralStaff's identity

Stepping back, the ideas in this file point at a shared
underlying principle: **GeneralStaff's value isn't automation,
it's verified automation for things humans actually want to
do**.

- The simulation mode (§1) verifies the plan before the work
- The verification gate (Hard Rule #6) verifies the work before
  the merge
- The budget guards (§3) verify the spend before the commit
- The model routing (§2) verifies the cost before the usage
- The "bring your own imagination" framing (§4) verifies that
  the project is one the user actually wants, not one the tool
  defaulted to because of its training distribution

Everything is a verification layer. Polsia has one verification
layer (the user's Stripe chargeback window) and it's reactive.
GeneralStaff has verification layers everywhere, and they're
preventive. **The product is the set of layers.**

This might deserve a tagline-level framing at some point —
maybe *"verified autonomous engineering"* where "verified" is
doing most of the work. Not committing to that phrasing now;
just noting the underlying coherence so a future session can
articulate it better.

---

**Captured:** 2026-04-15 evening, end-of-session chat
**Status:** Forward-looking ideas, not commitments
**Applied immediately:** §4 "Bring your own imagination" framing
  added to `README.md` in the same commit
**Phased plan updated:** Phase 3 prefers Retrogaze; Phase 10
  notes budget-per-bot; Phase 12+ added for simulation mode
**Next step:** Let the rest of these sit. Revisit in Phase 2+
  once the Phase 1 MVP is actually running. Premature scoping
  is its own form of slop.

---

## 7. Claude Design integration for UI work (Phase 5+)

**Captured:** 2026-04-18 mid-morning, after Ray flagged this
during the raybrain shakedown wait. Anthropic launched Claude
Design 2026-04-17 (the day before — see research-notes.md
§"2026-04-17 — Claude Design launched"). Ray runs Claude
Max ($200/mo subscription), so Claude Design is included
quota — opportunity cost of not using it for UI work is real.

**The problem Claude Design solves.** Generating
production-quality UIs is taste-heavy, slop-prone, and the
canonical example of "creative work the bot will confidently
get wrong" per Hard Rule #1. Today the bot is structurally
prevented from doing UI work because there's no way to verify
the output — `bun test && bun x tsc --noEmit` doesn't catch
"this looks bad". Claude Design changes that ratio: it
generates substantively better UI than a generic LLM,
constrained by visual design conventions Anthropic has
encoded into the tool, and the user can iterate by previewing
+ tweaking rather than reading raw TSX.

**Where this fits the GeneralStaff arc.**

- **Phase 5+ (local UI for GeneralStaff itself).** UI-VISION-
  2026-04-15.md sketches a kriegspiel/command-room dashboard
  for the dispatcher. Generating that UI via Claude Design
  rather than hand-rolling TSX could ship a Phase 5 polished
  enough to be portfolio-worthy in days instead of weeks.
- **Plugin: `generalstaff design <project>` for managed
  projects.** A registered project that needs UI work could
  request a Claude Design session — the dispatcher routes to
  Claude Design, captures the generated artifact in the
  project's repo, and the verification gate becomes "does the
  TSX type-check + the snapshot tests pass" rather than "is
  the UI good" (taste stays with the user).
- **raybrain Phase 3+ (query UI).** raybrain will eventually
  need a query interface — rendering wiki pages alongside
  raw citations per §6's invariant (4). Claude Design is the
  obvious tool to draft that interface; the four invariants
  remain enforceable post-render.

**Three integration paths to consider when the time comes.**

- **(a) Manual relay (cheap, Phase 5 starter).** User opens
  Claude Design in browser, generates UI, pastes the output
  into the project repo. Bot does no Claude Design work —
  GeneralStaff just needs to make it cheap to drop generated
  artifacts into a managed project's worktree without
  tripping hands-off rules.
- **(b) Claude-in-Chrome via Playwright (medium complexity).**
  Anthropic ships a Claude browser extension; combined with
  Playwright (which catalogdna already uses per
  research-notes.md §"2026-04-17 — Playwright + Chrome
  extension Claude precedent"), the dispatcher could
  programmatically drive a Claude Design session and capture
  the output. Powerful but fragile — DOM-driven automation
  is brittle and breaks on UI updates from Anthropic.
- **(c) Direct API integration (when/if Claude Design gets a
  programmable API).** Cleanest path. Today Claude Design is
  UI-only as far as we know; if Anthropic ships an API
  endpoint (likely eventually, given the pattern with their
  other features), GeneralStaff can call it the same way it
  calls the reviewer.

**Strong recommendation: don't pre-build (b) or (c).** The
manual-relay path (a) is cheap to support today (just
hands-off rules that allow drop-ins to specific paths like
`src/ui/generated/`), and (b)/(c) become evaluable only when
there's an actual UI workflow to integrate against. Don't
design the integration before the workflow exists.

**Why this is captured now rather than later.** Two reasons:
(1) Ray pays for Claude Max — the cost of NOT using Claude
Design for UI work is real, and we should explicitly route
toward it when UI tasks come up rather than have the bot
attempt UI generation on its own and produce slop. (2) The
Claude Design tool is new (2026-04-17) so the integration
landscape is unsettled — capturing the design intent now
prevents future sessions from defaulting to "have the bot
write TSX" out of habit when Claude Design is the better
tool.

**Connection to Hard Rule #1.** Claude Design doesn't violate
Rule 1 because the user is still the one making taste decisions
— they preview the generated UI, accept or iterate, and the
bot's role is just routing the request and committing the
artifact. The bot's industriousness is bounded by the
user's preview-and-approve loop, not turned loose on
"design something good".

### Addendum — 2026-04-18 afternoon: path (a) manual-relay empirically validated

Ray tested the **manual-relay path (a)** end-to-end on 2026-04-18
afternoon by taking feedback from a Claude Design session and
pasting it into a catalogdna interactive session. His report:
*"incredible job"*. This is the first empirical data point we
have on any of the three integration paths, and it validates
the §7 "don't pre-build (b) or (c)" recommendation — the
cheap path is already load-bearing useful.

**Implications for the GeneralStaff build order:**

1. **Phase 5 UI work starts with path (a).** Until a GeneralStaff
   plugin ships, the fastest way to get a polished kriegspiel
   dashboard (per `UI-VISION-2026-04-15.md`) is Ray running
   Claude Design in a browser and relaying output into the
   project via a regular interactive session. GeneralStaff
   doesn't need to be "in the loop" — it just needs to not
   block it.
2. **Hands-off rules should anticipate Claude Design drop-ins.**
   The projects.yaml hands_off list for any project doing UI
   work should explicitly permit a drop-in directory — e.g.
   `src/ui/generated/` — where Claude Design output lands
   without tripping reviewer rollbacks. This is cheap to add
   today; worth adding when the first UI workflow actually
   ships.
3. **(b) Playwright integration deferred further.** The
   catalogdna manual-relay success suggests the activation
   energy for (b) is higher than its marginal value over (a).
   Ray's ergonomics are already fine with the manual path;
   automating it would save minutes per iteration, not hours.
   (c) direct API integration is still the "right" long-run
   answer whenever Anthropic ships it.
4. **catalogdna is the natural pilot project for this pattern.**
   It already has a UI surface (worth understanding: does it
   count as "creative work" per Hard Rule #1, or is it
   correctness work on already-designed UI?) and Ray has
   high-fidelity taste for what catalogdna should look like.
   When Ray wants GeneralStaff to formally support catalogdna
   UI work, path (a) + the hands_off drop-in pattern is the
   first integration to ship. This is a Phase 5+ item; the
   validation note is captured now so we don't re-derive the
   answer later.

**What this doesn't change.** The §7 recommendation is unchanged:
don't pre-build (b) or (c), manual-relay is enough until a
real UI workflow stresses it. This addendum just records that
the empirical foundation for that recommendation is now real,
not hypothetical.
