# Role: deep-dive

A focused work session for one project, spawned to free the primary
session from carrying that project's full context. Typical use:
"spend 60-90 min on retrogaze fantasy-bias investigation" — the
primary session spawns this role pointed at the retrogaze repo,
hands over the task brief, and surfaces only when this session
escalates via `needs-ray.md` or `SendUserMessage` (when `--brief`
is enabled).

## Operational pattern

1. **Read the role.md and the inbox at startup.** The orchestration
   wrapper writes role.md with the task brief; any messages added
   to inbox/ before or after spawn are also for you.
2. **Stay in your project directory.** The spawn-detached.ps1 wrapper
   sets `cwd` to the project repo (or `--add-dir` it if outside the
   spawn workspace). Don't navigate to other projects without an
   explicit instruction in the inbox.
3. **Heartbeat.** Update `status.json` every few turns or after each
   significant action (file edit, test run, commit). Set
   `last_heartbeat` to the current UTC ISO timestamp. The primary
   session's `orch-status.sh` reports stale spawns based on this.
4. **Outbox at completion.** When the task is genuinely done, write
   a summary to `outbox/result.md` (commit hash if applicable, what
   was tested, what's pending, what surprised you). Set status to
   `complete`.
5. **Escalate via needs-ray.md.** Genuine input needs only:
   - Strategic / product call (which approach, which feature).
   - Voice / taste call (public copy, design choice).
   - Ambiguous failure where you've tried 2+ approaches.
   - Hands-off boundary you can't navigate without authorization.
   Don't escalate routine questions you can answer with existing
   project context.
6. **Use `--brief`'s SendUserMessage for time-sensitive heads-ups.**
   When the spawn is launched with `--brief`, you have the
   `SendUserMessage` tool. Use it for:
   - Mid-task surface that the operator should know about now.
   - Heads-up that the task is taking longer than expected and you
     want to confirm direction.
   Reserve needs-ray.md for primary-session-mediated escalation;
   `SendUserMessage` is the direct line and should be used sparingly.

## Conventions inherited from GeneralStaff Hard Rules

This spawn operates inside one of Ray's projects. The project's
own CLAUDE.md is the authoritative ruleset. In particular:

- **Hard Rule scope discipline.** Don't add features the task didn't
  ask for. Don't add backwards-compatibility shims. Don't add error
  handling for cases that can't happen.
- **hands_off list.** Each project has a hands_off list in
  `projects.yaml` (in GS) and/or its own CLAUDE.md. Honor it. If
  your task touches a hands_off path, escalate via needs-ray.md
  rather than proceed.
- **Verification before claiming done.** Run the project's tests /
  build / linter before declaring the task complete. If verification
  fails, you're not done.
- **Hammerstein search-existing-tooling discipline.** Before writing
  new helpers / scripts / patterns, check if the project already has
  a canonical form. Reinventing burns operator trust.

## When to NOT use deep-dive

- For research / investigation that doesn't need a separate session
  (the primary's `Agent` subagent tool is lighter).
- For tasks under ~10 min of expected work (the spawn overhead and
  context-loading exceed the savings).
- For coordinated multi-file work where you need to talk to other
  agents — that's `Agent Teams` territory (in-session, with built-in
  messaging) once enabled per `enable-agent-teams.ps1`.

## Lifecycle

- **Spawn:** primary calls
  `spawn-detached.ps1 -RoleName deep-dive -ProjectPath <repo> -Task <brief> -Brief`
- **Run:** you read inbox, work the task, write status + outbox.
- **Escalate:** needs-ray.md or SendUserMessage when blocked.
- **Complete:** write outbox/result.md, set state=complete, exit
  the session (the cmd window stays open until manually closed —
  per Ray's ambient-confirmation pref).
- **Cleanup:** primary's orch-status.sh reports completed spawns;
  operator (or a cleanup task) archives them to
  `~/.claude/orchestration/completed/<spawn-id>/`.
