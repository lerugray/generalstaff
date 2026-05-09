# Contributing to GeneralStaff

GeneralStaff is open source under AGPL-3.0-or-later. Contributions
welcome — read this doc first.

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
`docs/internal/RULE-RELAXATION-<date>.md` file committed alongside the change. PRs
that relax a Hard Rule without this log will be asked to add one. See
[`docs/internal/RULE-RELAXATION-2026-04-15.md`](docs/internal/RULE-RELAXATION-2026-04-15.md) for
the shape.

Design documents (`DESIGN.md`, `docs/internal/PIVOT-*.md`,
`docs/internal/PHASE-*.md`, `docs/internal/FUTURE-DIRECTIONS-*.md`,
`docs/internal/UI-VISION-*.md`) are append-only. New sections with
date headers are the right shape; rewrites of earlier sections are
not.

## Pre-PR contributor checklist

Before opening any PR with structural scope (new feature, dispatcher
change, anything beyond a typo or one-file localized fix), run through
this list:

- [ ] `bun test` — all tests pass.
- [ ] `bun x tsc --noEmit` — no type errors.
- [ ] If touching `src/verification.ts` / `src/reviewer.ts` /
      `src/safety.ts` / `src/prompts/` — explained in PR description
      how the verification gate's load-bearing behavior is preserved.
- [ ] If introducing or modifying a Hard Rule's enforcement path —
      added a `docs/internal/RULE-RELAXATION-<date>.md` file
      describing the change, its rationale, and what gates remain.
- [ ] If adding a new architectural concept — appended a dated
      section to `DESIGN.md` documenting it (don't rewrite earlier
      sections).
- [ ] If adding a new public CLI surface or config field — updated
      `README.md`, `QUICKSTART.md` if user-facing, and the relevant
      doc in `docs/conventions/` or `docs/integrations/`.
- [ ] If touching anything in `src/security`, key handling, or the
      audit log — flagged in PR description so a reviewer can pull
      `SECURITY.md` open against the change.

The dispatcher itself runs this checklist mentally for its own bot
PRs (per the verification gate). Human contributors run it
manually.

## Maintainer's companion repo

Ray maintains a private companion repo (`generalstaff-private`) for
maintainer-only state: per-machine paths, project state for
private-state projects (IP-sensitive missions, personal life-tools),
session notes, and credentials plumbing. This pattern is intentional
and documented in this public repo's `.gitignore` (each private-state
project has its `state/<id>/` directory excluded).

**Contributors do NOT need the private companion repo.** GeneralStaff
runs cleanly without it. The companion-repo pattern is purely for
the maintainer's own portfolio. If you ever need to contribute to a
file under `state/<id>/`, that project is private and your PR should
either touch a different project or wait for the maintainer to expose
the relevant interface. If you're confused about whether a project is
private-state, check `.gitignore` at repo root.

## Filing issues

For bug reports:
- Include the GeneralStaff commit SHA you were on.
- Include the relevant `PROGRESS.jsonl` lines if the bug happened
  during a cycle.
- Include your `projects.yaml` (with paths and any secrets redacted)
  if the bug is dispatcher-level.

For feature requests:
- Check [`docs/internal/FUTURE-DIRECTIONS-2026-04-15.md`](docs/internal/FUTURE-DIRECTIONS-2026-04-15.md)
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
