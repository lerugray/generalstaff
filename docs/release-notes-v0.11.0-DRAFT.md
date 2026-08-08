# DRAFT — GeneralStaff v0.11.0 release notes

These notes require an operator voice pass before release.

User-facing testing and iteration are now a managed framework concern. The
checks that previously depended on private discipline can be attached to a
project as an executable capability: the project authors a probe for its real
user path, and GeneralStaff runs that probe against the shipped artifact after
the unit gate. A green unit suite remains necessary; for user-facing work it is
not sufficient.

## Why this exists

One audit day produced three failures in builds whose full unit suites were
green:

- A turn-based strategy prototype serialized the full undo history inside each
  save-state snapshot. State grew exponentially until a real game exhausted
  memory and froze around ten moves in. Its 109 unit tests, self-play, and
  packaging checks had all passed.
- A tactics RPG permanently soft-locked every battle on every out-of-range
  enemy turn. The AI called movement APIs guarded for another mode; they
  silently did nothing. The build had only been boot-verified, so nobody had
  played as far as the first enemy movement.
- An arcade game advertised a single-file build but fetched sibling asset
  directories through relative paths. The staged copy played completely
  silent and showed no visible error.

These were not obscure engine assertions. They lived on the path a user walks:
the packaged load path, real UI events, accumulated state, enemy behavior, and
failure presentation.

## The managed gate

Projects can now define `player_path_command` beside
`verification_command`. GeneralStaff runs unit verification first, then the
project-authored player-path command. For a `public_facing` project, an
existing `customer_facing_smoke` runs afterward as an additional delivery
check. Any non-zero result stops the chain and fails verification.

The accompanying convention defines a shared evidence contract: stage outside
the repository, hash the artifact actually exercised, map named failure
surfaces, prove visual liveness, sample console/page errors and endurance heap
growth, and emit PASS only when the required evidence is attached. It also
makes silent failure a release blocker: shipped products should expose a
visible error and an exportable flight-recorder log.

Probe authoring is real, per-project, front-loaded effort. It is also
compounding infrastructure: every later build reuses the path, and each newly
mechanized failure surface strengthens every later release. GeneralStaff
provides the gate and the evidence convention; the project supplies the honest
user-path knowledge.
