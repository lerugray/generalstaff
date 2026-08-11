# GeneralStaff v0.12.0 — the claim-vs-screen battery

Your unit suite is green. Your changelog says the button works. On the
shipped build the button does nothing. Both of these are true at the same
time more often than anyone wants to admit, because agents see green inside
the repository and never look at what the user sees at the claimed moment.

v0.12.0 makes looking at the shipped build a managed part of the framework.

## What you get

- **A third verification stage.** Define `claim_battery_command` next to
  `player_path_command` in `projects.yaml`. GeneralStaff runs unit
  verification, then the optional player-path probe, then your
  claim-vs-screen battery against the shipped artifact. Exit 0 means every
  enumerated claim judged TRUE; non-zero fails the cycle.
- **A written convention.** [`docs/conventions/claim-battery.md`](../conventions/claim-battery.md)
  defines the battery: enumerate claims from changelogs / defect-fix lists /
  send-gate features; drive real input to the moment; capture before/after
  delta pairs; hash-guard identical frames as auto-FALSE; refute-first
  judges that look at the images; DOM + pixel dual assertion for option
  lists; any FALSE blocks ship.
- **Defined ordering.** The chain is
  `verification_command` → `player_path_command` → `claim_battery_command` →
  `customer_facing_smoke`. Absent `claim_battery_command` is a clean skip.
  When present, fail-closed. It composes with player-path and smoke; it does
  not replace them.

## Try it

```yaml
# projects.yaml
verification_command: "npm test"
player_path_command: >-
  node scripts/player-path-probe.mjs dist/app.html
  artifacts/player-path.json
claim_battery_command: >-
  node scripts/claim-battery.mjs dist/app.html
  claims/manifest.json artifacts/claim-battery.json
```

Author the battery in your project — claim list, input driver, screenshot
capture, judge, verdict table. Point the field at it. See the convention
doc for mechanics and a suggested claims-manifest shape.

## Why this exists

Green suites miss whole failure classes on the user's screen:

- Dead or blocked controls that the code path never exercises as UI.
- Actions that run but produce the wrong on-screen effect.
- Menus and dropdowns that omit required entries or offer the wrong ones.

A claim-vs-screen battery catches those by forcing a look at the shipped
artifact for every advertised claim.

## The honest cost

Claim enumeration and judge wiring are per-project, front-loaded effort.
You teach the battery your claims and input protocol once. It compounds from
there: every later send reuses the same claim set, and each newly mechanized
claim strengthens every later release.

## Feedback

If you wire this into a project, [open an issue](https://github.com/lerugray/generalstaff/issues)
with what your battery caught (or failed to catch) — the conventions doc
grows from real failure surfaces. And if GeneralStaff is useful to you, a
star helps other people find it.
