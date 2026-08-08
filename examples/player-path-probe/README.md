# Player-path probe skeleton

This is a deliberately incomplete reference probe. It stages one shipped file
outside the repository, hashes the staged copy, drives a browser through the
real load path, and writes a JSON evidence report. It exits non-zero until all
required adapter hooks provide real evidence.

Copy `player-path-probe.mjs` into the managed project and adapt the `adapter`
object. In particular:

- `launch()` must return a real Playwright/Puppeteer-style browser and page.
- `load()` must open the staged artifact exactly as a user does and return
  runtime identity such as `{ name, version }`.
- `driveIteration()` must use real input APIs (`keyboard`, `mouse`,
  `touchscreen`, or equivalent), report named coverage with non-empty evidence
  for each reached surface, and include boundary actions such as resize,
  blur/focus, and user-gesture audio where applicable.
- `visualSignature()`, `heapBytes()`, and `framesPerSecond()` must return real
  samples; `assertStallFree()` must inspect a meaningful progress signal.
- `requiredCoverage` must name the project's failure surfaces, not a step
  count. Set project-specific heap-growth and endurance thresholds.

Unadapted hooks throw `ADAPTER_REQUIRED`, so the template cannot accidentally
certify a build. Playwright and Puppeteer are intentionally not dependencies of
GeneralStaff; install one in the managed project and implement the hooks there.

Run it directly first:

```sh
node scripts/player-path-probe.mjs dist/shipped-artifact.html artifacts/player-path.json
```

Then register the project-authored probe:

```yaml
verification_command: "npm test"
player_path_command: >-
  node scripts/player-path-probe.mjs dist/shipped-artifact.html
  artifacts/player-path.json
```

GeneralStaff runs that command after `verification_command`. If the project is
also `public_facing` and defines `customer_facing_smoke`, that additional smoke
runs last. A non-zero result at any stage blocks the remaining stages.
