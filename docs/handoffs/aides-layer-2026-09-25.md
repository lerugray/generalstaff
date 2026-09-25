# Aides de Camp: an optional layer for persistent vendor agents (build lane, 2026-09-25)

grounded: master @ 545f388 (v0.14.0 plus two commits); CLI dispatch is the `switch` in `src/cli.ts`; credential-shaped
string detection already exists in `src/secrets.ts` (`redactSecrets`); tests run with `bun test`; CI includes
windows-latest.

## Why
People now run persistent, named AI agents that keep their own memory and credentials: a Grok-driven bot on a spare
machine, a vendor's personal agent such as Meta's Muse on its own hosted sandbox, and more on the way. The
maintainer's own fleet has run two of these alongside GeneralStaff for weeks under a written protocol. This lane
turns that protocol into an optional GeneralStaff layer called **Aides** (as in aides-de-camp). GeneralStaff talks to
an Aide through a registered **door**, reads its **inbox** as the record of what it did, never holds its credentials,
and gives any code an Aide writes no special trust: it goes through the verification gate like everything else.

## The protocol to encode (public restatement)
0. The class is Aides. An Aide is persistent, named, has its own memory, holds its own credentials, and acts with
   delegated authority. It is not a GeneralStaff engineer (engineers are per-cycle and disposable) and not the operator.
1. Every Aide registers a door: the one way GeneralStaff sends it a message (a local command, an append-only file the
   Aide reads, or an HTTP endpoint). Speak to the Aide through its door, never around it.
2. GeneralStaff never uses an Aide's credentials and never reaches into the Aide's machine except through its door.
3. Credentials are declared per Aide as a scope description (what the Aide can access). Values never appear in
   GeneralStaff config, and credentials never move between Aides without the operator's OK.
4. The operator tasks anyone. GeneralStaff may ASK an Aide for work through its door, naming the operator when it
   relays the operator's words. The Aide decides, and its inbox row records the decision.
5. Overlaps: whoever owns a surface declares it in an inbox row; the other stands down on that surface.
6. Disagreements: evidence wins; if it's inconclusive, the operator decides; either way it gets logged.
7. Trust but verify cheaply: inbox rows are the audit trail. Anything consequential without a row didn't happen.
   Claims about an Aide's own actions are checkable in the repo and should be checked.
8. Retirement: the inbox stays as an archive and the Aide's surfaces are re-homed in a row.
9. New Aides: a registry entry (identity, owner, capabilities, credential scope, hard lines), an inbox file, and a
   handshake row.

## Deliverable
1. `src/aides.ts`: loader and validator for `aides.yaml` (plus a committed `aides.yaml.example` with two illustrative,
   fictional Aides: a bot on another machine with a file door, and a hosted personal agent with a command door).
   Fields: `name`, `kind`, `owner`, `description`, `door` (`type: command | file | http` plus type-specific fields;
   for http, header values come from env var NAMES only), `inbox` (path), `capabilities[]`, `credential_scope` (free
   text), `hard_lines[]`.
2. Inbox format: markdown, append-only. Row heading `## <YYYY-MM-DD HH:MM TZ> <from>: <title> [tag]...`, bullet body.
   A parser and an appender (atomic write, same approach as the repo's existing atomic writes).
3. CLI `generalstaff aides …`: `list`, `show <name>`, `say <name> <message>` (sends through the door with no shell
   interpolation, then appends an outbound row to that Aide's inbox as the record), `inbox <name> [--since <time>]`,
   `watch [--json]` (poll inboxes, print each new row once; clean exit on SIGINT), `check` (validate the registry; fail
   on missing door or inbox, duplicate names, or any value that `redactSecrets` flags as credential-shaped).
4. Dashboard: if `generalstaff serve` makes it small, add a read-only Aides section (each Aide, its door type, its last
   five inbox rows). If it is not small, skip it and say why in the report.
5. `docs/AIDES.md`: what an Aide is, the rules above, a setup walkthrough using the two fictional examples, a security
   section (why GeneralStaff never holds an Aide's credentials, doors as the only contact surface, how Aide-authored
   branches enter through a normal cycle and the gate), and what the layer does NOT do.
6. README: one bullet under "Optional layers". CHANGELOG: an `## Unreleased` entry. No version bump, no tag, no release.
7. Tests (`bun test`): loader/validator, inbox parse and append (including concurrent appends), `say` for command and
   file doors with a fake command, `check` catching a planted credential, CLI wiring. Report the full-suite counts
   before and after; the full suite must stay green.

## Constraints
- This is a PUBLIC repository. No real hostnames, IP addresses, emails, usernames, machine names or private paths in
  code, docs, examples or tests. The example Aides are fictional.
- Additive only: do not change cycle, gate, reviewer or dispatcher behaviour.
- Windows and Unix: no bash-only door execution (spawn with an argv array); paths through `path`.
- No new runtime dependencies unless the repo already parses YAML with one (use the same library it uses).
- Do not commit, push or merge; the wrapper commits your tree as found.
