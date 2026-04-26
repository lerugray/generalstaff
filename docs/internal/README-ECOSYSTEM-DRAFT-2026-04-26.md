# README ecosystem section — drop-in draft (2026-04-26)

This is a drop-in draft for a "Sister projects" section to land in
the public README between `## Works alongside` and `## Opt-in knobs`.

**Do not paste into the public README yet.** The section references
mission-brain / mission-bullet / mission-swarm as public template
repos. Each is gated:

- **mission-brain** waits on rb-046 validation passing (the
  consult_voice MCP wiring) AND the rb-047 Phase 2 extraction work
  shipping the `mission-brain` repo public.
- **mission-bullet** waits on its own Phase 2 (public-readiness
  audit + scrub + voice-pass + repo flip).
- **mission-swarm** waits on Phase 2 building v0.1 from scratch
  (the repo is currently v0.0.0 scaffold).

Ideally all three additions land in the public GS README in a single
coherent commit once each repo is publicly visible. A staggered rollout
is acceptable but means partial-ecosystem README states between
mission-* launches.

---

## Drafted section (insert into public README)

Header level 2 (`##`); follows the existing "Works alongside" section
style but distinguished as sibling-projects-by-the-same-author rather
than external complements.

```markdown
## Sister projects

GeneralStaff is one of four open-source tools sharing a design floor:
your data on your disk, your keys for paid providers, no SaaS layer.
Each tool is standalone — none depend on the others — but they
compose well for a personal AI workflow built entirely on local
files and BYOK provider calls.

- **[mission-brain](https://github.com/lerugray/mission-brain)** —
  queryable second brain over your own writing. Citation-grounded
  retrieval over your corpus (markdown, Facebook export, journal
  entries, music metadata, whatever you have). Refuses to write
  unsourced claims. Voyage embeddings (cloud) or Ollama (local).
- **[mission-bullet](https://github.com/lerugray/mission-bullet)** —
  AI-assisted bullet journal in the Ryder Carroll method. Daily
  capture, weekly review, monthly migration. AI surfaces themes
  and proposes migrations; never modifies your raw entries.
- **[mission-swarm](https://github.com/lerugray/mission-swarm)** —
  swarm simulation engine for plausible audience reactions.
  Lean ~20% of MiroShark, scoped to kriegspiel and pre-launch
  reaction smoke-tests. Round-by-round streaming, audience-template
  driven.

GS-managed projects can invoke any of these as subprocesses or, for
mission-brain, via its MCP server. The integrations are opt-in per
project; default GS posture is no integration assumed.
```

---

## Notes on phrasing choices

- **"Sister projects"** vs **"Companion tools"** vs **"The mission
  family"**: "Sister projects" reads cleanest and stays neutral on
  whether the relationship is hierarchical (which it isn't —
  GeneralStaff doesn't depend on the mission-* tools, and
  mission-* tools don't depend on GS).

- **No em-dashes** in the body text (slop-pass discipline). Replaced
  with parentheses, periods, and explicit clauses where appropriate.

- **"Lean ~20% of MiroShark"** is verbatim from the mission-swarm
  README and strategy doc; preserves the attribution + scope-honesty.

- **"Refuses to write unsourced claims"** is the mission-brain
  citation-floor commitment, important enough to lead with even
  in a one-line tool description.

- **MCP-server mention for mission-brain** flags an opt-in
  integration without overselling it. Most readers won't know what
  MCP is yet; the link will lead them to mission-brain's README
  for that.

---

## Pre-publish checklist

Before adding this section to the public README:

- [ ] rb-046 validation passes cleanly (consult_voice wiring works
      and returns useful citations).
- [ ] mission-brain repo is public on GitHub and has a working README
      that delivers on the link's implied promise.
- [ ] mission-bullet repo is public AND scrubbed of Ray-personal
      paths AND has a public-facing README with the privacy hero.
- [ ] mission-swarm repo is public AND has working v0.1
      implementation (not a v0.0.0 scaffold) AND has a public README.
- [ ] All four repo URLs in the section actually resolve.
- [ ] Stop-slop pass on the section text.
- [ ] Ray's voice-pass on the framing.

If any item is unchecked, defer the README update.

---

## Phasing options if all-at-once isn't workable

If shipping all three mission-* repos public in a coordinated burst
is impractical, the ecosystem section can land in stages:

**Stage 1** — only mission-brain public:

```markdown
## Sister projects

GeneralStaff is part of an open-source family of tools sharing a
design floor: your data on your disk, your keys for paid providers,
no SaaS layer.

- **[mission-brain](https://github.com/lerugray/mission-brain)** —
  queryable second brain over your own writing.
  [...full bullet...]

Two more sibling tools (mission-bullet, mission-swarm) are in
development; this section will expand as they ship.
```

**Stage 2** — mission-bullet ships: add its bullet, drop the
"in development" caveat for it.

**Stage 3** — mission-swarm ships: add its bullet, drop the
trailing caveat entirely.

Staged rollout produces three small commits each adding a clean
public reference rather than one big commit landing all three.
Either approach is fine; the staged version reduces "what if one
of them isn't quite ready" risk.
