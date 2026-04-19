# Contributing to GeneralStaff

Pre-launch note: this repo is private at time of writing. This doc
describes how contributions will work once public; current practice
is Ray + the autonomous bot only.

## The short version

- **Correctness PRs are welcome.** Bugs, tests, small features with a
  clear spec, documentation fixes, type improvements — open an issue
  or a PR.
- **Taste-work PRs need a conversation first.** Hard Rule 1 applies to
  contributors: if your PR touches design direction, the project's
  editorial voice, the Hard Rules themselves, or any file listed in a
  `hands_off` surface, open an issue describing the change before
  writing the PR. Saves everyone's time.
- **The audit log is the bug report.** If you hit a bug running the
  tool, the best report is a snippet of your own `PROGRESS.jsonl`
  showing the exact cycle that failed. Designed to be diff-friendly.

## Before opening a PR

- Run `bun test` — currently 1000+ tests, should stay green.
- Run `bun x tsc --noEmit` — no type errors.
- Match the existing code style. `src/` conventions live in
  [`CLAUDE.md`](CLAUDE.md) — file-based state, atomic writes,
  subprocess isolation for external commands, explicit fail-safes
  over defensive try/catch walls.
- If your change touches the verification gate (`src/verification.ts`),
  the reviewer (`src/reviewer.ts`), safety (`src/safety.ts`), or
  prompts (`src/prompts/`), explain in the PR description how you
  verified the change doesn't regress the gate's load-bearing
  behavior. These files are load-bearing against the Hard Rules.

## What stays off-limits for PRs

Hard Rules cannot be relaxed without an explicit
`RULE-RELAXATION-<date>.md` file committed alongside the change. PRs
that relax a Hard Rule without this log will be asked to add one. See
[`RULE-RELAXATION-2026-04-15.md`](RULE-RELAXATION-2026-04-15.md) for
the shape.

Design documents (`DESIGN.md`, `PIVOT-*.md`, `PHASE-*.md`,
`FUTURE-DIRECTIONS-*.md`, `UI-VISION-*.md`, `VOICE.md`,
`LAUNCH-PLAN.md`) are append-only. New sections with date headers are
the right shape; rewrites of earlier sections are not.

## Filing issues

For bug reports:
- Include the GeneralStaff commit SHA you were on.
- Include the relevant `PROGRESS.jsonl` lines if the bug happened
  during a cycle.
- Include your `projects.yaml` (with paths and any secrets redacted)
  if the bug is dispatcher-level.

For feature requests:
- Check [`FUTURE-DIRECTIONS-2026-04-15.md`](FUTURE-DIRECTIONS-2026-04-15.md)
  first — many ideas are already captured there.
- Describe the problem, not the solution. The solution shape is
  Ray's judgment call.

## Sponsors and support

Per Hard Rule 10, there's no GeneralStaff-the-company. Financial
support goes to Ray personally through
[GitHub Sponsors](https://github.com/sponsors/lerugray). See
[`SUPPORTERS.md`](SUPPORTERS.md).

## License

AGPL-3.0-or-later. By contributing, you agree your contributions are
licensed under the same terms. See [`LICENSE`](LICENSE).
