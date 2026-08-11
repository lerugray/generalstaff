# Player-path verification

A green unit suite proves that an engine is correct in isolation. It proves
nothing about the path a user walks through the shipped artifact.
Only a player-path (or user-path) probe against the **shipped artifact**, run
from an out-of-tree location, verifies what ships.

GeneralStaff does not supply a universal product test. A project authors its
own probe, and GeneralStaff runs it as the optional `player_path_command` gate.

## The gate

Before a user-facing build is surfaced to the operator or any external party,
an automated probe must:

1. Copy the exact release artifact to a temporary location outside the
   repository and hash the exercised copy.
2. Load it by the real delivery path (`file://` for a single-file build when
   that is what the user opens, or the real packaged/server entry point).
3. Drive real browser or device input events through the user interface. Calls
   directly into engine modules are not player-path evidence.
4. Traverse the project's named failure-surface map: its important screens,
   verbs, state accumulation, transitions, failure/restart paths, and the real
   opponent or hazard system. Raw step, turn, or elapsed-time counts are not a
   coverage claim.
5. Fail on a page error, console error, stall, dead control, missing asset,
   failed liveness assertion, uncovered required surface, or unacceptable
   endurance trend.

Where state accumulates, run past the known danger boundary with margin. For a
real-time experience, require meaningful engagement such as a collision,
failure, restart, or completed objective; polite input playback is not enough.
Exercise boundary behavior too: a brief rapid-input burst around a transition,
one resize, one blur/focus cycle, and one audio action caused by a real user
gesture.

## Evidence contract

A comparable PASS report attaches all of the following:

- the staged artifact path and SHA-256 of the copy actually exercised;
- browser/runtime identity, start/end timestamps, deterministic seed, and an
  input-script description;
- a named failure-surface coverage map with pass/fail evidence for every
  required state, mechanic, and transition;
- periodic visual-liveness assertions showing that pixels or meaningful UI
  state changed in response to input;
- console-error and uncaught-page-error samples plus stall-detector results;
- periodic heap samples and, where relevant, frame-rate samples on endurance
  runs, with a project-defined limit for gross monotonic growth; and
- an overall verdict that is PASS only when every required item above is
  present and passing.

Hash the shipped file. Comparing it with a rebuilt copy is only meaningful when
the release process promises reproducible builds.

The reference skeleton in `examples/player-path-probe/` fails loudly until its
browser adapter and project-specific coverage hooks are implemented. A release
pipeline should retain its JSON report beside the other verification evidence.

## Failures must be loud

A user-facing failure must produce a visible error and an exportable debug log,
never a silent no-op. Standard equipment is a small flight recorder: a ring
buffer of recent inputs, transitions, and state changes; error and stack
capture; build/version identity; and one-click export. If a candidate lacks
that failure surface, or the probe finds a loud failure, an external send is
blocked.

For an external candidate, also verify that the exact artifact is retained and
hashed, its version is visible in-product, naive-open instructions work, a
feedback route is supplied, and error/log export works. Printed collateral,
formal acceptance, and service obligations are separate, audience-specific
checks.

## Ordering with `customer_facing_smoke`

The verification chain is:

`verification_command` → `player_path_command` → `claim_battery_command` → `customer_facing_smoke`

`player_path_command` is the automated shipped-artifact floor for user-facing
work. `claim_battery_command` is an optional claim-vs-screen battery (see
[`claim-battery.md`](claim-battery.md)); it does not replace the player path.
`customer_facing_smoke` is an optional, additional check for projects marked
`public_facing`; it can cover naive-open and other human-shaped delivery
concerns. It does not replace the player path. Any non-zero stage stops the
chain and fails verification. Non-interactive deliverables need no player-path
gate; an intentionally raw or broken artifact may be shown only by an explicit
operator decision, never because the unit suite is green. During unstable
art/physics/fix rounds, bootstrap the harness and run one smoke traversal;
reserve the endurance run for the release candidate.

## Cost and enforcement

Probe authoring is per-project, front-loaded work. Its value compounds:
every later build reuses and extends the same executable path. Conventions only
reliably catch what becomes code, so prefer mechanized gates and machine-checked
evidence contracts over prose checklists.
