# GeneralStaff — Launch Plan

**Status:** Forward-looking planning doc. Append-only per section;
each new entry is date-stamped so the history is legible.

## 2026-04-17 — Initial capture

### Positioning

**Accurate framing (use this verbatim):** *"Open-source alternative
to Polsia — autonomous engineering with the anti-slop architecture
Polsia doesn't have."*

**Avoid:** "We open-sourced Polsia" (wrong — can't open-source
someone else's proprietary software; looks sloppy and picks an
unnecessary legal fight). **Also avoid:** "Polsia killer"
(aggressive, reads as VC-posture; we're not trying to kill
anyone, we're offering the principled version).

**One-line pitch:** *"Polsia assumes you want a SaaS. GeneralStaff
doesn't care what you're building. Bring your own imagination; the
tool runs the execution."* (From FUTURE-DIRECTIONS §4, already in
README.)

### Pre-launch gates (don't ship before these)

1. **Phase 1 + Phase 2 shipped.** Phase 1 DoD (verification gate
   catches scope drift + hands-off violations, PROGRESS.jsonl
   full audit, digest files, cycle chaining, ≥5 supervised clean
   cycles) substantively met by 2026-04-17 with 30+ dogfood
   cycles — effectively closed (formal PHASE-1-COMPLETE marker
   TBD; see "Open question" below). Phase 2 per PIVOT §"Phased
   build plan" = Reviewer + verification gate (already shipped)
   + multi-provider routing (in-flight on the 2026-04-17 chain
   session, gs-150..gs-163).
2. **Phase 3 second-project validation.** At least one non-
   GeneralStaff project running cycles (gamr per §5 of
   FUTURE-DIRECTIONS). Proves generality; without it the
   generalizability claim is unprovable and the README is
   weaker.
3. **Phase 4 Tauri UI at least preview-able.** A launch without
   a clickable install path for non-CLI users is wasted ammo.
   Per FUTURE-DIRECTIONS §10, the Tauri installer is the
   non-programmer distribution vehicle — launching without it
   caps the reachable audience at developers who can run
   `bun src/cli.ts`.
4. **README polished.** Voice-calibrated pass after gs-109 +
   gs-110's structural + voice work. Must pass the "a skeptical
   Hacker News reader can see the point in 30 seconds" test.
5. **SUPPORTERS.md + GitHub Sponsors link live.** Rule 10
   alignment: Ray-personally or foundation, never
   "GeneralStaff LLC."

**Open question:** do we want a formal `PHASE-1-COMPLETE-2026-
04-17.md` marker file documenting the close (cycle count, DoD
check, any deviations), or do we roll Phase 1's closure into
the launch writeup itself? The marker is nice for launch-story
credibility ("Phase 1 closed on 2026-04-17 with N clean cycles,
here's the PROGRESS.jsonl range") but a bit ceremonial for a
dogfood project. Either is fine; Ray picks.

### Pre-launch artifact checklist

- [ ] `README.md` — final prose pass, badges, one animated
      PROGRESS.jsonl screenshot
- [ ] `SUPPORTERS.md` — empty-but-present at launch; starts
      populating after first donors
- [ ] `CONTRIBUTING.md` — brief, anti-slop-aligned (Rule 1
      applies to contributors too: correctness PRs welcome,
      feature PRs that extend into taste-work flagged)
- [ ] `LICENSE` — currently... check which; probably AGPL-3.0
      fits the anti-extraction stance but may over-scare
      enterprise users. Revisit.
- [ ] GitHub Sponsors configured
- [ ] Release tag v0.1.0 cut
- [ ] Install one-liner tested end-to-end from a clean machine
- [ ] At least one non-Ray person runs it end-to-end successfully

### Platforms (in order of leverage)

1. **Show HN post.** Real launch moment for dev tooling.
   Title candidates:
   - *"Show HN: GeneralStaff — open-source alternative to Polsia,
      verification-first"*
   - *"Show HN: We wrapped Claude Code agents to prevent the Polsia
      2-minute auto-commit failure mode"*
   - *"Show HN: Kriegspiel for your codebase — autonomous
      engineering that refuses to commit slop"*
   Test each against "would a skeptical HN reader click this."
2. **Long-form article.** Cross-post across Medium + dev.to +
   Ray's own site. Content is cheap to mirror; don't pick one.
   The article's job is not traffic — it's the canonical piece
   someone links to when arguing "there's an OSS version of
   Polsia."
3. **r/ClaudeCode** — target audience already using Claude Code
   and likely recognizing the pain points GeneralStaff
   addresses (runaway bot commits, verification pain, hands-off
   enforcement gaps). High signal-to-noise subreddit.
4. **X longform thread** launch day. Tags the usual OSS + dev
   tool accounts. Hooked on a specific screenshot or quote.
5. **Secondary dev communities:** r/programming, r/opensource,
   r/selfhosted, r/LocalLLaMA, Lobste.rs, dev tool newsletters
   (TLDR, Refind). Cross-post same article link; don't rewrite
   per-platform.
6. **Later-wave outreach:** swyx's newsletter, Simon Willison's
   weekly links, Latent Space — high trust dev-tool coverage
   but requires an angle that makes the project newsworthy
   beyond "another OSS tool."

### Narrative hooks (pick 2-3 per piece)

- **Generalist-to-OSS-author arc.** Ray's background (30+ board
  games, record production, minimum-wage day job) produced the
  specific pattern-matching that Polsia's specialist VC founders
  lack. Honest + specific; avoids cliche.
- **Hammerstein framing.** Industriousness-without-judgment is
  the worst quadrant; GeneralStaff's Hard Rules structurally
  prevent it. This is the intellectual spine and
  Marxism-compatible per VOICE.md §Intellectual framing.
- **"Built itself" dogfooding.** GeneralStaff's own PROGRESS.jsonl
  is public evidence — you can audit every cycle, every verdict,
  every diff. Screenshottable. Polsia can't show you this.
- **Polsia auto-commit-in-2-minutes.** Trustpilot review quoted
  verbatim: *"Within 2 minutes flat, it had entered me into
  obligations that I couldn't back (automatically offered free
  products to influencers). It took too long to find the OFF
  switch."* This is the opening hook.
- **Verification-first vs. lock-in-first.** Single most
  structural difference. One sentence each: Polsia commits first,
  you chargeback later; GeneralStaff verifies first, you merge
  later.
- **"Bring your own imagination."** Neutral on project
  motivation — SaaS, art project, satirical anti-startup, blog
  read by four people, all valid. Differentiates against
  Polsia's implicit startup-accelerator framing.

### Anti-patterns to avoid in launch content

- **Don't demo-hack.** No "watch GeneralStaff build a SaaS in 10
  minutes" videos. That's Polsia's genre; doing it worse than
  them loses, doing it better validates their framing.
- **Don't over-promise "autonomous."** The Hard Rules EXIST
  because autonomous-everything is the failure mode. Lead with
  what the tool refuses to do; that's the honest pitch.
- **Don't gate on flashy UI.** Phase 4 UI is the install vehicle,
  not the hero. The hero is the verification gate + the audit log.
- **Don't apologize for local-first.** It's a feature. "Your
  code never leaves your machine" is a value proposition, not
  a limitation.

### Screenshots / artifacts to prepare

- PROGRESS.jsonl tail showing a verification_failed cycle being
  correctly rejected (post-gs-132)
- Terminal output of a clean 10-cycle session with green
  verified-count
- The Hard Rules list (from RULE-RELAXATION-2026-04-15.md)
  rendered as a readable graphic
- Side-by-side config comparison: Polsia's dashboard vs.
  projects.yaml + tasks.json (readable text files vs. locked
  cloud state)
- The kriegspiel campaign-map wireframe (UI-VISION sketch) even
  if the UI isn't built — grounds the visual brand

### Post-launch followups

- Monitor Show HN comments in real time; reply within 2h of
  first critique (HN rewards quick, substantive author engagement)
- Collect every "I tried it and..." issue in a single tracking
  doc; respond-rate matters for first-100-users trust
- Update LAUNCH-PLAN.md itself with lessons learned, new
  platforms that worked, articles that landed vs. died. It
  becomes a living retrospective.

### Legal / ethical constraints

- The Polsia critique stays specific and sourced (Trustpilot
  quotes, public pricing, public marketing copy). No speculation
  about their internals.
- Never imply their product is fraudulent — it's structurally
  flawed for principled use, not a scam. Different claim.
- Never use screenshots of Polsia's actual UI without clear
  fair-use commentary framing.

---

**Author:** Initial draft captured by Claude (interactive session)
during the 2026-04-17 afternoon chain-session prep. Follow-on
edits should append to this file with date headers, not rewrite.

## 2026-04-18 — Phase renumbering + gate updates

The 2026-04-17 initial capture above used PIVOT-2026-04-15.md's
original Phase numbering, where Phase 4 = Tauri UI shell. That
numbering was re-sequenced during 2026-04-18 when multi-project
throughput became the actual next bottleneck ahead of UI — we
had three registered projects (generalstaff + gamr + raybrain)
each with real backlogs, and sequential dispatch was leaving
60-75% of wall clock idle from the picker's perspective. The
original "Phase 8" parallel worktrees moved up to Phase 4 and
shipped 2026-04-18 afternoon; UI shifts to Phase 5.

**Pre-launch gate updates:**

- Gate #1 (Phase 1+2 shipped): ✓ closed 2026-04-17.
- Gate #2 (Phase 3 second-project validation): ✓ closed
  2026-04-18 morning — `gamr` ran 5 verified cycles + `raybrain`
  was registered and ran Phase 1 autonomously (27-min session,
  zero intervention). See PHASE-3-COMPLETE-2026-04-18.md.
- Gate #3 **re-scoped from Tauri UI preview → Phase 4 parallel
  worktrees shipped**. Parallel mode closed 2026-04-18 afternoon
  (PHASE-4-COMPLETE-2026-04-18.md). The original Tauri/UI gate
  is now a Phase 5 target; we don't gate launch on it because:
    - The CLI surface is feature-complete for the MVP value
      proposition (verification gate + audit log + multi-project
      + parallel throughput).
    - Non-CLI onboarding can ship via a web README walkthrough +
      `generalstaff bootstrap` first, with the Tauri installer
      as a Phase 5 enhancement post-launch.
    - The gs-188 observability surface (`parallel_efficiency`,
      `slot_idle_seconds`, digest rendering, status --sessions
      Parallel column) gives the eventual UI its data contract
      — read side is already done; Phase 5 is view/control only.
- Gate #4 (README polished) and Gate #5 (SUPPORTERS.md): still
  open. The README status block was refreshed 2026-04-18 to
  reflect Phases 1-4 shipped; a full voice pass per VOICE.md is
  the remaining polish item.

**New lesson worth capturing from the 2026-04-18 arc:** the
"minimal human interaction post-seed" thesis — feed 5 bounded
tasks into `state/<project>/tasks.json`, launch one bot session,
land 5 verified implementations — is now structurally
demonstrated across 3 projects (generalstaff, gamr, raybrain).
That's a stronger demo artifact for the launch than any UI
preview would be. **The demo should be the PROGRESS.jsonl of
the raybrain Phase 1 session** (27 min wall, 5/5 verified, zero
intervention mid-session), not a Tauri screenshot. The audit
log is the product.

**Still on the don't-over-promise list:** the parallelism story
is real but load-bearing for a very specific user — someone
with ≥2 managed projects and BYOK spend willingness. The README
copy should NOT frame it as "10× speedup" or similar — that's
Polsia territory. It's opt-in multiplicative throughput, and
the honest framing is "when your fleet grows past one project,
you can set `max_parallel_slots: N` and pay roughly N× reviewer
spend for N× cycle count per session." Literal, not aspirational.

## 2026-04-18 evening — Gates #4 and #5 closure

Shipped in one interactive session (commit `086d1c9`):

- **Gate #4 (README polished):** structurally closed via twelve
  edits against the ten-point VOICE.md-aligned plan (tagline widened
  from "for solo founders" per VOICE.md §3 neutrality-on-motivation;
  status block compressed and de-dated; "Built by itself" dogfooding
  callout added near top per VOICE.md §9.1; labor-economics paragraph
  added to "The problem" per VOICE.md §1; concrete dogfooding example
  added to "The approach"; human-livability opener added to "Who
  this is for" per VOICE.md §3; Hammerstein section expanded with
  the lazy+clever ranking and Hard-Rule-1 tie; roadmap cleaned —
  Phase 5 split into visual-anchor ✓ closed + UI shell in progress,
  "Phase 7" replaced with "Public launch" framing). Further
  sentence-level prose polish is Ray's judgment call; structural
  surface is complete.
- **Gate #5 (SUPPORTERS + LICENSE):** closed.
  - `LICENSE`: **AGPL-3.0-or-later**. Canonical text from
    gnu.org. Chosen over MIT to prevent the SaaS-fork attack (a
    Polsia competitor forking GS and reselling as closed SaaS) that
    the project positions against. The AGPL-over-scares-enterprise
    concern captured in §"Pre-launch artifact checklist" above
    applies to enterprise-sales projects; GS's audience per
    VOICE.md is solo developers / minimum-wage-adjacent, not
    enterprise-legal-filtered. The plugin-ecosystem chilling effect
    AGPL sometimes produces is low-risk here because GS is a thin
    wrapper over Claude Code with plugins that run as separate
    processes.
  - `SUPPORTERS.md`: empty sponsor list at launch; naming opt-in.
  - `CONTRIBUTING.md`: new — correctness PRs welcome, taste-work
    PRs need an issue first (Hard Rule 1 for contributors), audit
    log is the bug report.

**VOICE.md is public-by-intent.** Flagged to Ray that the personal-
context section (minimum-wage framing) would be visible to anyone
cloning the public repo. Ray confirmed keep public — the openness
is on-brand for a project whose credibility claim is "our audit
log is the product," and the public voice-calibration document is
itself a voice signal competitors cannot match.

### Remaining pre-launch items

- **Clone URL in README Quickstart.** Currently points at
  `https://github.com/lerugray/generalstaff.git` which is a private
  repo — will 404 for public readers until launch day. Flag-for-
  launch-day, not a pre-launch edit.
- **README sentence-level polish.** Any specific prose Ray wants
  to rework is an interactive-session task; the structural voice
  pass is complete.
- **Final artifact checklist items from §"Pre-launch artifact
  checklist" above.** GitHub Sponsors live link, release tag
  v0.1.0, install one-liner end-to-end test, first non-Ray user
  runs it successfully — all still open, all outside the scope
  of tonight's close.
