# Claim-vs-screen battery

A green unit suite proves that code paths return the expected values. It
proves nothing about what the user sees when those paths fire. Agents
working inside a repository are structurally blind to that surface: they
see green in code and miss dead controls, wrong on-screen effects, and
incorrect option lists.

The claim-vs-screen battery forces a look at what the user sees. For every
enumerated claim about shipped behavior, the battery drives the shipped
build to the exact moment the claim fires, captures screenshots, and judges
TRUE/FALSE against the claim text for that moment.

GeneralStaff does not supply a universal battery. A project authors its
own command, and GeneralStaff runs it as the optional `claim_battery_command`
gate. Exit 0 means every enumerated claim judged TRUE; non-zero fails the
cycle closed.

## Design principle

The agent sees the product from inside the box. Green tests report what the
code believes happened; they do not report what appeared on screen. The
battery closes that gap: trigger screenshots at the claimed moment, put the
claim text in the judge's hand, and require a look before a verdict. A
verdict without the look is void.

Failure classes a green suite is blind to:

1. Dead or blocked controls — the UI will not let the user do the claimed
   action.
2. Wrong on-screen effects — the action runs, but what appears is not what
   the claim says.
3. Wrong option lists — menus and dropdowns omit required entries or offer
   the wrong ones.

## The battery

Against the **shipped artifact**, before every external send:

1. **Enumerate the claims.** Every changelog / release-notes line, every
   fixed defect on the report list, and every send-gate feature is a CLAIM
   ("pressing X does Y", "menu Z now lists W").
2. **Drive to the moment.** Use real input (Playwright-class or equivalent)
   to reach the exact moment the claim fires, and trigger screenshot(s)
   there.
3. **Delta pairs, not lone after-frames.** Every interactive claim captures
   BEFORE-input and AFTER-input screenshots. The judge rules on the CHANGE
   against the claim. A lone after-frame cannot prove "the control did
   nothing."
4. **Hash guard.** Identical image hash across a claimed fix is automatic
   FALSE — no judge call needed. If nothing changed, the fix did not ship.
5. **Refute-first judges that look.** Judges receive the claim text plus a
   refute-first posture (not an open "does this look right?"). They must
   look at the images. Uniform-wrongness (everything wrong the same way) is
   the known blind spot; the hash guard and dual assertion below mitigate it.
6. **DOM + pixel dual assertion for option-list claims.** Check the
   widget's actual option list in the DOM deterministically *and*
   screenshot it. The list assertion catches absence with certainty; pixels
   catch clipping, occlusion, and contrast that DOM cannot see.
7. **ANY FALSE = not shipped.** Whatever the unit suite says, fix it or
   strike the claim from the changelog / release-notes / defect-fix list
   before send. Land a verdict table (claim, screenshot path(s), T/F, note)
   beside the other verification evidence.
8. **Named limit.** The battery covers **enumerated claims only**. Unknown
   unknowns remain the job of free-play / player-path probes and soak
   gates. The protection is the composition; no single seam claims
   completeness.

## Ordering with the other gates

The verification chain is:

`verification_command` → `player_path_command` → `claim_battery_command` → `customer_facing_smoke`

- `verification_command` — unit / typecheck floor.
- `player_path_command` — automated free-play / shipped-artifact user path.
- `claim_battery_command` — claim-level seam: each advertised claim gets a
  screenshot verdict.
- `customer_facing_smoke` — optional public-facing naive-open / delivery
  check.

Any non-zero stage stops the chain and fails verification. Absent
`claim_battery_command` is a clean no-op (stage skipped). When present,
fail-closed on non-zero exit. The battery composes with player-path and
smoke; it does not replace them.

## Worked example

Claims (neutral placeholders):

1. "Save button writes a file"
2. "Settings menu lists Theme / Language / About"

Drive the shipped build, capture before/after for Save, capture the open
Settings menu (DOM list + screenshot), judge each claim.

Sample verdict table:

| claim | screenshot path(s) | T/F | note |
| --- | --- | --- | --- |
| Save button writes a file | `artifacts/claims/save-before.png`, `artifacts/claims/save-after.png` | T | file appeared; hashes differ |
| Settings menu lists Theme / Language / About | `artifacts/claims/settings-menu.png` | F | DOM missing Language; pixel crop confirms |

Battery exit code: non-zero (one FALSE). Cycle fails. Fix or strike claim 2
before ship.

## Claims-manifest shape (suggested)

Projects may keep an explicit manifest the battery reads. Shape is
suggestive, not enforced by GeneralStaff:

```json
{
  "claims": [
    {
      "id": "save-writes-file",
      "text": "Save button writes a file",
      "kind": "interactive",
      "require_delta_pair": true
    },
    {
      "id": "settings-menu-entries",
      "text": "Settings menu lists Theme / Language / About",
      "kind": "option_list",
      "expected_options": ["Theme", "Language", "About"],
      "dual_assert_dom": true
    }
  ]
}
```

Interactive claims should require delta pairs. Option-list claims should
dual-assert DOM and pixels. The battery owns exit semantics: all TRUE → 0;
any FALSE → non-zero.

## Wiring in GeneralStaff

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

Author the battery in the project. Point `claim_battery_command` at it.
GeneralStaff runs it as the third verification stage when prior stages
passed. Rollback-on-failure stays with the dispatcher when the verification
outcome is failed — same as player-path.

## Cost and enforcement

Claim enumeration and judge wiring are per-project, front-loaded work. The
value compounds: every later send re-runs the same claim set against the new
artifact, and each newly mechanized claim strengthens every later release.
Conventions only reliably catch what becomes code, so prefer a mechanized
battery and a machine-checked verdict table over a prose checklist.
