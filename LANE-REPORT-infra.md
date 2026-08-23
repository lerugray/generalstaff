# LANE-REPORT — infra (wt-infra)

1. CI `test` job is now a 3-OS matrix: ubuntu-latest, macos-latest, windows-latest (bun install --frozen-lockfile, bun test, typecheck).
2. New `installer-smoke` job (ubuntu + macos only): runs install.sh in a temp HOME, asserts `generalstaff --version` / `--help` exit 0.
3. Windows CI runs the suite only — no invented Windows installer smoke (install.ps1 left untouched per scope).
4. install.sh default ref: newest `v*` tag via `git ls-remote --tags --refs` + `sort -V`; `GENERALSTAFF_BRANCH` remains the explicit override.
5. Existing clones fetch tags and checkout that ref (branch → ff-only pull; tag → detached HEAD).
6. `bun install --frozen-lockfile`; on failure, message tells user to re-run with `GENERALSTAFF_BRANCH=master`.
7. Validated: `bash -n install.sh` OK; workflow YAML `yaml.safe_load` OK.
8. Local suite: 2225 pass / 4 skip / 1 fail — failure is flaky `engineer.test.ts` log footer race, unrelated to these two files.
9. Commits: `ci: run full test suite on ubuntu, macos, and windows`; `install.sh: default to latest v* release with frozen lockfile`. Not pushed.
10. Touched only `.github/workflows/test.yml`, `install.sh`, and this report.
