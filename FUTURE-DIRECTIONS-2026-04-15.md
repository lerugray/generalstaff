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
