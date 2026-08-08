# GeneralStaff v0.11.0 — the player-path gate

Your unit suite is green. Your shipped build freezes ten moves in. Both of these
are true at the same time more often than anyone wants to admit, because unit
tests exercise the engine in isolation and nobody exercises the path a user
walks through the artifact you actually ship.

v0.11.0 makes that second check a managed part of the framework.

## What you get

- **A second verification stage.** Define `player_path_command` next to
  `verification_command` in `projects.yaml`. GeneralStaff runs unit
  verification first, then your player-path probe against the shipped
  artifact. Non-zero exit fails the cycle — an agent can't call user-facing
  work done on unit green alone.
- **A reference probe you can copy.** [`examples/player-path-probe/`](../examples/player-path-probe/)
  is a commented skeleton: stage the artifact outside the repo, hash it, load
  it the way a user would (`file://` for single-file builds), drive the real
  UI with real input, sample console errors and heap growth, emit an evidence
  report.
- **An evidence contract.** [`docs/conventions/player-path-verification.md`](conventions/player-path-verification.md)
  defines what a PASS must prove: the hash of the artifact exercised, which
  states were reached, visual liveness, zero console errors, bounded memory.
  A probe that can't fail loudly doesn't count.
- **A loud-failure rule for shipped builds.** Silent no-ops are the failure
  class that survives every other gate. The convention treats a visible error
  and an exportable debug log as standard equipment, and silent failure as a
  release blocker.

## Try it

```yaml
# projects.yaml
verification_command: "npm test"
player_path_command: >-
  node scripts/player-path-probe.mjs dist/app.html
  artifacts/player-path.json
```

Copy the skeleton from `examples/player-path-probe/`, replace the marked hooks
with your app's real menu protocol and core loop, and run it against your
staged artifact. The probe's README covers adaptation.

## Three failures green suites shipped

All three happened in one audit day, in different projects, with full unit
suites passing:

- A turn-based strategy prototype serialized the full undo history inside each
  save-state snapshot. State grew exponentially until a real game exhausted
  memory and froze around ten moves in. Its 109 unit tests, self-play, and
  packaging checks had all passed.
- A tactics RPG permanently soft-locked every battle on every out-of-range
  enemy turn. The AI called movement APIs guarded for another mode; they
  silently did nothing. The build had only been boot-verified, so nobody had
  played as far as the first enemy movement.
- An arcade game advertised a single-file build but fetched sibling asset
  directories through relative paths. The staged copy played silent and showed
  no visible error.

None of these are obscure engine bugs. They live on the user's path: the
packaged load path, real UI events, accumulated state, failure presentation.
A unit suite structurally cannot see them. A player-path probe catches all
three.

## The honest cost

Probe authoring is per-project, front-loaded effort — you have to teach the
probe your app's real input protocol once. It compounds from there: every
later build reuses the path, and each newly mechanized failure surface
strengthens every later release.

## Feedback

If you wire this into a project, [open an issue](https://github.com/lerugray/generalstaff/issues)
with what your probe caught (or failed to catch) — the conventions doc grows
from real failure surfaces. And if GeneralStaff is useful to you, a star helps
other people find it.
