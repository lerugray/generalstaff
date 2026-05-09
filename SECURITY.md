# Security

**Status:** v0.3.0+. First-pass threat model + secret-handling guide.

GeneralStaff is local-first and BYOK. The user is the security boundary
— there is no cloud surface to compromise on our end. This doc
documents what that means in practice and what the tool expects you to
get right.

## Reporting a vulnerability

If you find a security issue:

- **Preferred:** open a [GitHub Security Advisory](https://github.com/lerugray/generalstaff/security/advisories/new)
  on the public repo. Private to the maintainers until disclosed.
- **Alternate:** email Ray at `lerugray@gmail.com` with subject line
  starting `[GS SECURITY]`. Acknowledgment within ~72 hours when Ray
  is at a machine.

Please do not file public issues for security problems before
coordinating disclosure.

## Secret storage

GeneralStaff does not store secrets itself. Provider keys (Anthropic,
OpenRouter, etc.) are read from one of:

1. **Environment variables.** `ANTHROPIC_API_KEY`,
   `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, etc. Standard pattern.
   Loaded by your shell, inherited by the dispatcher subprocess.
2. **A user-controlled `.env` file** at a path the user manages
   (commonly `~/.generalstaff/.env`). Ray's own setup uses this; the
   path is not assumed by the codebase. If you use this pattern,
   `source ~/.generalstaff/.env` before launching `gs`.
3. **Provider CLI tools.** The `claude` provider can use Claude Code's
   own auth token (no separate API key needed if you have a Pro / Max
   subscription). The `aider` provider reads aider's own config.

GeneralStaff never writes secrets to disk, never logs them in
`PROGRESS.jsonl`, and never transmits them anywhere except to the
provider you configured.

## Recommended file-system protections

If you use a `.env` file:

- **Mac / Linux:** `chmod 600 ~/.generalstaff/.env` so only your user
  can read it. Combine with FileVault (Mac) or LUKS (Linux) for
  at-rest encryption.
- **Windows:** restrict ACLs on the file to your user account.
  Combine with BitLocker for at-rest encryption.

Provider keys in environment variables inherit your shell's
visibility. On a single-user desktop this is fine; on a shared
machine, prefer a per-user `.env` at a restricted path over a
system-wide environment.

## Threat model

GeneralStaff's design assumes:

- **You trust the codebase you point it at.** The dispatcher runs
  `verification_command` (your tests) and the engineer's diffs in your
  shell. If the project repo contains hostile code, GeneralStaff will
  run it the same way `npm test` would.
- **You trust the LLM provider you configured.** Provider responses
  are not sandboxed — if a provider returns malicious tool-call output
  and your engineer model executes it, the consequences are local.
  The verification gate catches behavioral deviations (failed tests,
  hands-off violations, empty diffs); it does not sandbox the
  engineer's runtime.
- **You trust your own filesystem.** State, audit logs, and the
  `.bot-worktree` checkout live on local disk. GeneralStaff has no
  remote storage.

GeneralStaff does NOT assume:

- That the LLM is honest or competent. The verification gate, hands-off
  list, reviewer model, and audit log all exist because the LLM is
  treated as adversarial input. Verdict is by code, not by prompt.
- That you want to hand the bot a long leash. By default, the bot
  works in `.bot-worktree/` on a `bot/work` branch. It cannot push to
  `master` and cannot push to remotes other than your project's own
  `bot/work` ref.

## Specific deployment scenarios

### Multi-user desktop

If multiple users share a machine:

- Use per-user `.env` files at restricted paths (`chmod 600` /
  user-only ACLs).
- Each user runs their own `gs` instance against their own `state/`
  directory. The dispatcher reads state from the path declared in
  `projects.yaml`; nothing is shared by default.
- Avoid putting provider keys in `/etc/environment` or other
  system-wide env stores.

### CI / automation adapters

GeneralStaff is designed as a developer-loop tool, not a CI tool. If
you wrap it in CI:

- **Never log the environment.** CI logs are commonly archived; a
  `printenv` step will leak provider keys to anyone with read access
  to the build history.
- **Use the CI's secrets store** (GitHub Actions Secrets, GitLab CI
  Variables, etc.) to inject keys at runtime. Don't commit `.env`
  files to the repo.
- **Treat `bot/work` as ephemeral in CI.** If you want CI to merge
  bot work to a feature branch, do that via your CI's git operations,
  not by extending GeneralStaff itself. Hard Rule: GS does not push
  to `master`.

### Shared LLM provider account

If your team shares a single Anthropic / OpenRouter account:

- Each developer should have their own per-user API key with
  separate rate limits and a separate billing trail. Provider
  dashboards typically support multiple keys per account.
- Audit log entries in `PROGRESS.jsonl` include cycle metadata but
  not the API key used. If you need to attribute spend to an
  individual, do that on the provider side via the key.

## Known limitations

- **Tag signing is not enforced.** Maintainer release tags are
  unsigned at the time of v0.3.0. If you require GPG-signed releases,
  pin to a specific commit SHA from the changelog instead and verify
  via the audit-log narrative for that version.
- **Dependency supply chain.** GeneralStaff has a small dependency
  surface (Bun runtime + a handful of typed libraries) but does not
  perform automated supply-chain scanning. If you ship in a security-
  sensitive environment, audit `package.json` and run your own scan.
- **Reviewer model may be on a third-party provider.** The reviewer
  step typically runs on whatever model you configured for
  `GENERALSTAFF_REVIEWER_PROVIDER`. If you use OpenRouter / DeepSeek
  for the reviewer, you're sharing diffs with that provider during
  review. Configure accordingly.
- **`PROGRESS.jsonl` may contain code excerpts.** The audit log is
  designed to be inspectable. If your project contains secrets in
  source files (it shouldn't), excerpts of those secrets may appear
  in `PROGRESS.jsonl`. Treat the audit log with the same sensitivity
  as the project source.

## Hard Rule alignment

The verification gate, hands-off enforcement, and audit log are
load-bearing per the project's Hard Rules (see [`DESIGN.md`](DESIGN.md)
and [`CONTRIBUTING.md`](CONTRIBUTING.md)). Changes to
`src/verification.ts`, `src/safety.ts`, `src/reviewer.ts`, or
`src/prompts/` require explicit reviewer attention in PRs and should
be accompanied by a `docs/internal/RULE-RELAXATION-<date>.md` file if
they reduce a Hard Rule's coverage. This applies to security-relevant
changes too.
