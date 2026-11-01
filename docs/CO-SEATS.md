# Co-seats

A co-seat keeps your fleet moving while nobody has a session open. When a cycle finishes, or on a timer, it wakes one short agent turn. The turn reads what happened, takes the next step inside limits you set, writes down what it knows and ends. Anything only a person can decide goes on a list for you.

This layer is optional and does nothing until you configure it. It does not relax the gate: work still lands only through a project's own verification, reviewer and `auto_merge` setting. The authoritative design is the "§v11: Co-seats" section at the end of [`DESIGN.md`](../DESIGN.md).

## What a co-seat is

A co-seat has two parts.

- **The driver.** `generalstaff co-seat run` is a small loop with no model in it. Every 60 seconds it checks for stops and the deadline, looks for new events, and decides whether a turn is due.
- **The turn.** One bounded, headless agent run that you configure (for example `claude -p`). It starts fresh each time. It reads a standing brief and a state file, acts inside the authority you declared, rewrites the state file and ends. Its only memory between turns is that state file.

The design rule is that every safety rail lives in the driver or in a GeneralStaff command, never only in the prompt. The brief tells the turn what to do. Code decides whether a turn runs, which account pays for it, how long it lives, whether a stop holds (also mid-turn), which projects it may cycle, and how often it may ask you for something.

### When to use one

Use a co-seat when you want to walk away for hours or days and still have someone read finished cycles, judge them, start the next gated cycle, verify outside work when it lands, and hold your questions in one place.

Do not use one when:

- You only need a fixed batch of cycles on a schedule. Run `generalstaff session` from cron or a timer. It needs no agent turn.
- You want a live session that reacts to actions you queue by hand. That is heartbeat mode.
- The work is a release, a deploy or publishing. Those stay with a person.

| | `generalstaff session` on a schedule | Heartbeat mode | Co-seat |
|---|---|---|---|
| What runs | The picker runs cycles in one process | One interactive session kept alive by a Stop hook | A fresh headless process per turn |
| What starts work | The schedule | Actions someone queues in an inbox | Finished cycles, Aide inbox rows, outside sentinel files, and a timer |
| Memory | None | Fresh context per event | One state file |
| Judgment between cycles | None | The session acts on what was queued | The turn reads results and decides |
| Questions for a person | None | None | Parked, with a daily cap |

Heartbeat mode ([`docs/HEARTBEAT.md`](HEARTBEAT.md)) is unchanged and unrelated. A co-seat's own "heartbeat" is only its minimum wake interval.

## Quick start

You need GeneralStaff installed, a command that can run one headless agent turn from a prompt (the examples use Claude Code), and a meter command for each runner (see [Writing a meter](#writing-a-meter)).

1. **Register your projects.** A seat can only cycle registered projects, and every cycle keeps its normal gates.

   ```bash
   generalstaff register app --path=/path/to/app
   generalstaff register site --path=/path/to/site
   ```

2. **Add a minimal co-seat block** to `projects.yaml`, under `dispatcher:`. A fuller example, with every key, is in [`projects.yaml.example`](../projects.yaml.example).

   ```yaml
   dispatcher:
     co_seats:
       - id: main
         brief: ./co-seat/BRIEF.md
         state_file: ./co-seat/STATE.md
         projects: [app, site]
         authority:
           verify: true
           land: false
           park_per_day: 2
           aide_messages_per_day: 0
         runners:
           - id: primary
             command: [claude, -p, "{prompt}", --permission-mode, dontAsk,
                       --settings, ./co-seat/claude-settings.json,
                       --output-format, stream-json, --verbose]
             meter:
               command: [./scripts/meter-primary.sh]
               max_used_percent: 85
         wake:
           heartbeat_seconds: 1800
           min_gap_seconds: 300
         turn_timeout_seconds: 1800
         run_days: 7
   ```

3. **Write the templates.** `init` writes the brief, the state file and the Claude Code settings file to the paths in your block. It never overwrites an existing file, which is why the block comes first.

   ```bash
   generalstaff co-seat init --id=main
   ```

4. **Edit the brief.** Open `co-seat/BRIEF.md` and fix every `<!-- EDIT: ... -->` marker: the seat's id, its projects, what you care about. Keep it short, because the turn reads it every time.
5. **Write a meter** and make it executable. Test it by hand first.
6. **Start it.**

   ```bash
   generalstaff co-seat go --id=main --days=7
   generalstaff co-seat status --id=main
   ```

   `go` records the config pin and a deadline seven days out, then does one watchdog pass, which starts the driver. The driver holds turns until the brief and the state file exist and the state file has all six headings, so `init` before `go`.
7. **Schedule the watchdog.** `generalstaff co-seat watchdog --id=main` every five minutes keeps the seat alive across reboots and logouts. Ready-made files for systemd, launchd, cron and Windows Task Scheduler are in [`examples/co-seat/`](../examples/co-seat/).

To look in on it, run `generalstaff co-seat status --id=main`, read `co-seat/STATE.md`, and run `generalstaff forks` to see what is parked for you. To stop it, run `generalstaff co-seat stop --id=main`.

A driver started by a scheduler sees only the scheduler's environment, not your shell profile. If a runner's `env` names a variable that is unset or empty there, that runner is skipped. Give the scheduled job the variables it needs, for example through a small wrapper script that loads a private file only you can read and then runs the watchdog.

### Defaults

Every key except `id`, `brief`, `state_file`, `projects` and `runners` has a default. Unknown keys are an error, so a typo fails at load instead of being ignored.

| Key | Default |
|---|---|
| `authority.verify` | `true` |
| `authority.land` | `false` |
| `authority.park_per_day` | `2` |
| `authority.aide_messages_per_day` | `0` (no Aide sends) |
| `wake.heartbeat_seconds` | `1800` |
| `wake.min_gap_seconds` | `300` |
| `wake.cycles` | `true` |
| `wake.aide_inboxes` | `true` |
| `wake.done_globs` | `[]` |
| `turn_timeout_seconds` | `1800` |
| `run_days` | `7` (`go` and `extend` accept up to 30) |
| `remote_control.remote` | `origin` |

## How a turn works

Each tick, the driver does these things in order.

1. **Ends or idles.** It ends when the deadline has passed or the seat's own `STOP` exists, and writes `EXIT.json` with the reason. It idles (no turn, but it keeps ticking) while the fleet STOP exists, while the remote control says stop, and while the config pin has changed. See [Safety rails](#safety-rails).
2. **Collects wake events.** New `cycle_end` records in the seat's projects, new non-outbound rows in registered Aide inboxes, outside sentinel files that are new or changed (`wake.done_globs`), plus notes for the first turn, for a heartbeat, and for a previous turn that was killed or whose state file was restored. The driver records what it has seen at collection time, so anything that lands during a turn shows up in the next one.
3. **Decides whether a turn is due.** A turn is due when there are events and `min_gap_seconds` has passed since the last turn, or when `heartbeat_seconds` has passed.
4. **Picks a runner.** The first runner whose meter reads under its limit and whose `env` variables are all set takes the turn. If none qualifies, there is no turn; the driver logs it once and checks again in 10 minutes.
5. **Runs the turn.** It snapshots the state file, writes `EVENTS.md` and `PROMPT.md`, and starts the runner's command with `{prompt}` filled in (or the prompt on stdin if the command has no placeholder). The turn's environment includes `GS_CO_SEAT=1`, `GS_CO_SEAT_ID`, `GS_CO_SEAT_TURN` and `GS_CO_SEAT_DIR` (the turn's own `turns/<n>/` directory, which holds `EVENTS.md`). A runner's `env` cannot set or unset these. While it runs, the driver keeps watching for stops and the turn timeout.
6. **Records the result.** A turn that fails to start, or exits with an error within a minute, hands its events forward: the next turn sees them under `CARRIED FROM TURN n`.
   Prompt, events, runner, meter reading, exit code, duration and end reason go to `turns.jsonl`, and the turn's output goes under `turns/<n>/`. If the state file lost a required heading or vanished, the driver restores the snapshot and records `state_restored`. If a turn was killed, the next turn's events tell it to check the bot worktrees with `generalstaff status` before starting any cycle.

Inside the turn, the agent follows the brief: read the state file and the events, act, rewrite the state file, end. It acts only through GeneralStaff commands, so every cycle it starts is gated the same way as one you start yourself.

## Safety rails

Each rail below says what it guarantees and, where it matters, what it does not.

### Meters fail closed

Before a turn, the driver runs the meter command of each runner in order, with a 15 second timeout. A non-zero exit, a timeout, empty output, or anything that is not a number from 0 to 100 reads as **100**. A runner is used only if its reading is under its `max_used_percent`.

Guarantee: a broken or missing meter never grants a turn. No runner available means no turn.

Not guaranteed: a turn is not stopped when a meter crosses its limit mid-turn. The start-of-turn check and the turn timeout bound the spend. Set `max_used_percent` with one turn of headroom.

### STOP: local, fleet and remote

- **Local STOP.** `generalstaff co-seat stop` writes the seat's `STOP` and removes `GO`. The driver ends. The stop is sticky: only `generalstaff co-seat go` restores `GO`.
- **Fleet STOP.** `generalstaff stop` writes the STOP file every cycle already obeys. It idles the seat. Run `generalstaff start` to clear it and turns resume.
- **Remote STOP.** If you configure `remote_control`, the seat idles while the remote branch has a `STOP` marker, has no `GO` marker, or cannot be fetched. See [Remote control](#remote-control).

Guarantee: while a turn runs, the driver checks the local and fleet STOP every 10 seconds and the remote marker every 60 seconds, and kills the turn's whole process tree on a stop. A stop therefore holds mid-turn, and it needs no agent turn. Unreadable control holds turns; it never grants them.

### One driver per seat

The driver takes a lock directory (`lock/` under the seat's state directory) holding its pid, host, a nonce and its start time, and touches a `heartbeat` file every tick. A stale lock is taken over by renaming it aside first, and only one taker's rename can succeed, so two watchdogs cannot both start a driver. The driver releases the lock on every exit path.

The running turn's pid is recorded in `turn.json`. If the driver itself dies, the next driver (and `co-seat stop`) kills that turn before anything else, so an orphaned turn cannot run beside a new one. On Linux and macOS, anything the turn left running in its process group is stopped when the turn ends, so the brief tells the turn to run cycles in the foreground. A `turn.json` written on another host holds turns until a person removes it.

### Deadline and extend

`go` sets a deadline (`run_days` by default, up to 30 days). Past it the driver ends and writes `EXIT.json`, and the watchdog does not restart it. `generalstaff co-seat extend --id=main --days=7` moves the deadline and changes nothing else. `status` warns when under 24 hours remain.

The deadline also stops a running turn, the same way a STOP does. `turn_timeout_seconds` is at most 7200.

Guarantee: a seat cannot run forever by accident, and a turn cannot extend its own life (see the guards below).

### Config pin

`go` records a hash of the seat's config block, the config of each of its projects (including `auto_merge` and `hands_off`) and the brief. If any of them changes, turns hold until a person runs `go` again.

The pin also covers `dispatcher.state_dir`. If the seat's state directory moves, the running driver exits rather than split from the path `stop` and `status` use.

Guarantee: a turn that edits its own authority loses it at once. Every command that uses the seat's authority refuses for the rest of that turn, and no further turn starts. Edit the config or the brief on purpose, then run `go` to accept the change.

### Guards that do not trust the turn

With `GS_CO_SEAT=1` set, which the driver sets for every turn:

- `generalstaff start` (which clears the fleet STOP), `co-seat go` and `co-seat extend` refuse. A turn cannot lift a stop or extend its own life.
- `generalstaff session`, `autonomous`, `welcome` and `engineer-benchmark` refuse. Anything that dispatches cycles across projects does not belong inside a bounded turn.
- `generalstaff cycle`, `cycle verify` and `cycle-redo` refuse a project outside the seat's `projects`, and refuse when `--project` is given more than once with different values. `cycle verify` also refuses when `authority.verify` is `false`.
- `co-seat run` and `co-seat watchdog` refuse, so a turn cannot start a second driver.
- `co-seat park` and `co-seat stop` act only on the turn's own seat.
- `generalstaff aides say` counts against `aide_messages_per_day` and refuses past it.
- `co-seat stop` stays allowed, so a seat can stop itself.

Caps are read from config, not from the caller, and counted in the seat's state directory behind a lock, so turns racing each other cannot exceed them. Every guard first checks that the config still matches the pin `go` recorded; if it does not, the command refuses.

### Park and Aide-message caps

- `generalstaff co-seat park` writes an entry to the same `fork-ledger.json` that autonomous mode uses, so parked items show in `generalstaff forks` and on the dashboard. It refuses past `park_per_day` items per local day. Parking a pending id again only refreshes it and costs nothing. Parking an id the person already resolved refuses and prints their resolution, so the turn learns the answer instead of asking twice.
- `aide_messages_per_day` limits Aide door sends per local day. `0` means none.

### `authority.land` for `auto_merge` projects

A project with `auto_merge: true` may be listed in a seat only if the seat's config says `authority.land: true`. Config loading fails otherwise. Unattended merging is always an explicit choice, and the project's own gate still decides each merge. A co-seat adds no merge path.

### Other guarantees

- No project belongs to two co-seats. One owner per project.
- Hands-off lists still bind every cycle.
- Every turn is logged with its full prompt in `turns/<n>/PROMPT.md`.
- The co-seat pushes to no project remote. The only optional pushes are marker commits to a control repo outside every project.

## Trust boundary

The turn runs as the same operating-system user as the driver. These rails stop mistakes, drift and an agent that wanders. They do not contain a hostile agent with shell access, which could kill the driver itself. If you need that protection, run the turn as a separate OS user or inside a sandbox.

## Writing a meter

A meter answers one question: how much of this runner's allowance is used? The contract is small.

- Print a used percent from 0 to 100, either as a bare number (`42`) or as JSON (`{"used_percent": 42}`), and exit 0.
- Anything else reads as 100: a non-zero exit, no output, text that is not a number, a number outside 0 to 100, or running longer than 15 seconds.
- Keep it fast and read-only. It must not spend the allowance it measures. Send log lines to stderr, not stdout.

Test it by hand before you trust it:

```bash
./scripts/meter-primary.sh; echo "exit $?"
```

### Example 1: a fixed budget

This meter ignores any provider and enforces a cap you choose: at most 24 turns in the last 24 hours. It counts the prompt files the driver wrote.

```bash
#!/usr/bin/env bash
# meter-budget.sh: print the share of a 24-turns-per-day budget already used.
set -euo pipefail

ROOT="/path/to/GeneralStaff"
ID="main"
BUDGET=24

# The turns directory does not exist before the first turn; treat that as zero.
used=$({ find "$ROOT/state/_co-seat/$ID/turns" -name PROMPT.md -mtime -1 2>/dev/null || true; } | wc -l | tr -d ' ')
pct=$(( used * 100 / BUDGET ))
if [ "$pct" -gt 100 ]; then pct=100; fi
echo "$pct"
```

### Example 2: wrap a usage command you already have

If you have a command that reports usage for the account a runner bills, wrap it. Replace `my-usage-tool` and the `jq` path with whatever your tool prints.

```bash
#!/usr/bin/env bash
# meter-primary.sh: report the used percent for the primary account.
set -euo pipefail

used=$(my-usage-tool report --json | jq -r '.window.used_percent')
printf '{"used_percent": %s}\n' "$used"
```

If the tool fails, `set -e` and `pipefail` make the script exit non-zero, which reads as 100 and holds the turn. If `jq` finds no field it prints `null`, which also reads as 100. That is the behavior you want.

## Runners and fallback

`runners` is an ordered list. The driver picks the first runner that is under its meter limit and has every `env` source variable set and non-empty. It re-picks before every turn, so a fallback takes over when the primary is near its limit and hands back when the primary recovers, with no restart.

| Key | Meaning |
|---|---|
| `id` | A name for logs and `status`. |
| `command` | The argv to run. `{prompt}` is replaced with the turn's prompt. With no placeholder, the prompt goes on stdin. |
| `env` | Map of child variable to the **name** of a variable in the driver's environment, for example `CLAUDE_CODE_OAUTH_TOKEN: MY_PRIMARY_TOKEN`. Values never go in the YAML. |
| `env_unset` | Variables removed from the child's environment, for example `[ANTHROPIC_API_KEY]`, so a turn cannot bill the wrong account. |
| `meter` | `command` (see above) and `max_used_percent`. |

Put the account you prefer first and a second account or tool after it with a higher limit:

```yaml
runners:
  - id: primary
    command: [claude, -p, "{prompt}", --permission-mode, dontAsk,
              --settings, ./co-seat/claude-settings.json,
              --output-format, stream-json, --verbose]
    env: { CLAUDE_CODE_OAUTH_TOKEN: MY_PRIMARY_TOKEN }
    env_unset: [ANTHROPIC_API_KEY]
    meter: { command: [./scripts/meter-primary.sh], max_used_percent: 85 }
  - id: fallback
    command: [claude, -p, "{prompt}", --permission-mode, dontAsk,
              --settings, ./co-seat/claude-settings.json,
              --output-format, stream-json, --verbose]
    env: { CLAUDE_CODE_OAUTH_TOKEN: MY_FALLBACK_TOKEN }
    env_unset: [ANTHROPIC_API_KEY]
    meter: { command: [./scripts/meter-fallback.sh], max_used_percent: 95 }
```

GeneralStaff passes no permission-bypass flag. The runner command is yours. The `claude-settings.json` template is for Claude Code: it allows `generalstaff` commands, reads, and writes to the state file only, and it denies edits to `projects.yaml`, the brief, STOP files, the fork ledger, `aides.yaml` and the co-seat state directory. It also denies `generalstaff start`, `co-seat go`, `co-seat extend`, `git push`, `WebFetch` and `WebSearch`. JSON has no comments, so the file carries none. If you move the brief or state file from `./co-seat/`, change the paths in it to match. If you use a different agent CLI, give it equivalent limits in that tool's own terms.

## Remote control

Remote control lets you stop or start a seat from a phone or another machine, without a shell on the seat's machine. It uses marker files on a branch of a git repository you own.

1. Create a repository for control only, and clone it on the seat's machine at a path outside every registered project.
2. Add the block to the seat's config:

   ```yaml
   remote_control:
     repo: ../my-control-repo   # a git checkout outside every registered project
     remote: origin
     branch: main
     dir: co-seat/main
   ```

3. Run `generalstaff co-seat go --id=main --remote`. This commits the `GO` marker. Because the config changed, the pin changed too, so this `go` is also how you accept it.
4. To stop from anywhere, push a commit that adds a file named `STOP` to `co-seat/main/` on that branch. You can also run `generalstaff co-seat stop --id=main --remote` from a machine that has the checkout. The seat idles within a minute, including during a turn. To resume, run `generalstaff co-seat go --id=main --remote`.

The seat idles whenever the branch has a `STOP` marker, has no `GO` marker, or cannot be fetched. A chat or phone bridge can use either route: write the local `STOP` file on the seat's machine, or push the remote `STOP` marker. The in-flight check honors both within a minute.

## Command reference

All commands run as `generalstaff co-seat <command>`. `--id` picks the seat and may be left out when only one co-seat is declared.

| Command | What it does |
|---|---|
| `init [--id=<id>]` | Writes the brief, state and Claude Code settings templates to the configured paths. Never overwrites. |
| `go [--id=<id>] [--days=N] [--remote]` | Clears the local STOP, writes `GO` with the config pin and a deadline N days out (default `run_days`, at most 30), optionally commits the remote `GO` marker, then does one watchdog pass. |
| `extend [--id=<id>] [--days=N]` | Moves the deadline. Nothing else. |
| `stop [--id=<id>] [--remote]` | Writes `STOP` and removes `GO`. A running turn is killed within 10 seconds. `--remote` also commits the remote `STOP` marker. Needs no agent turn. |
| `status [--id=<id>] [--json]` | Live or not, heartbeat age, turn count, deadline (warns under 24 hours), last runner and meter reading, markers, pin state, items parked today, and the last `EXIT.json`. |
| `watchdog [--id=<id>]` | For a scheduler, every few minutes. Idempotent. Inside the deadline, with `GO`, no local `STOP` and no live lock, it starts the driver detached. |
| `run [--id=<id>] [--once]` | The driver itself. Normally started for you by `go` and `watchdog`. `--once` runs a single tick and exits. |
| `park [--id=<id>] --project=<id> "<what the person decides>" [--evidence=<path>]` | Writes a fork-ledger entry for a person to decide. Refuses past `park_per_day`. |

## File layout

Under the directory named by `dispatcher.state_dir` (default `./state`), each seat keeps its files in `state/_co-seat/<id>/`:

```text
state/_co-seat/<id>/
  GO            present while the seat should run; holds the config pin and the deadline
  STOP          present after `co-seat stop`; sticky until `co-seat go`
  EXIT.json     why the driver last ended
  lock/         single-instance lock: pid, host, nonce, start time
  heartbeat     touched every tick
  driver.log    the driver's own log
  turns.jsonl   one record per turn: prompt, events, runner, meter reading,
                exit code, duration and end reason
  turns/<n>/    PROMPT.md, EVENTS.md, and the turn's stdout and stderr
  turn.json     the running turn's pid, while a turn runs
  carry.json    events handed forward from a failed turn
```

The driver also keeps small bookkeeping files here, such as event watermarks, the daily caps and their lock files. Do not edit them.

Outside that directory:

```text
co-seat/BRIEF.md              the standing brief (you edit it)
co-seat/STATE.md              the seat's only memory; the turn rewrites it
co-seat/claude-settings.json  limits for a Claude Code runner
state/fork-ledger.json        parked items, shared with autonomous mode
```

The state file has six fixed headings: `Open items`, `Owned work`, `Waiting on`, `Held by a person`, `Parked` and `Last turn`. If a turn removes one, the driver restores the previous copy of the file. The turn never touches items under `Held by a person`.

## What it does not do

- It does not release, deploy or publish anything.
- It adds no merge path of its own and no model-run merge. Code lands only where a project's own gate lands it.
- It does not kill a turn when a meter crosses its limit mid-turn. Use `max_used_percent` with one turn of headroom.
- It does not coordinate seats beyond one owner per project.
- It has no general file-watch wake source. `wake.done_globs` covers outside work's sentinel files.
- It has no hosted relay. Nothing is hosted.
- It does not run `generalstaff session`, and it never pushes to a project remote.
- It does not make taste decisions. Those are parked for a person.
