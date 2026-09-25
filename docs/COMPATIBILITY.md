# Compatibility & product surfaces

Single page for what a new reader otherwise has to reconstruct across
README, DESIGN, the marketing site, and this repo vs companion repos.
Facts below are grounded in those sources as of CLI **v0.15.0**
(`package.json`).

## Product surfaces

| Surface | What it is | Where it lives | Required? |
| --- | --- | --- | --- |
| **GeneralStaff CLI** | The engine: dispatcher, verification gate, cycle/session commands (`gs` / `generalstaff`). Install this first. | This repo (`github.com/lerugray/generalstaff`); `package.json` `bin` → `./src/cli.ts` | **Yes** — core product |
| **GeneralStaff Desktop (GSD)** | Optional local viewer/controller UI (fleet, workbench, live sessions). Hard Rule 2 permits a local desktop UI as viewer/controller; it is not the engine. | Separate repo: [github.com/lerugray/generalstaff-desktop](https://github.com/lerugray/generalstaff-desktop) (releases linked from `site/index.html`) | **No** — optional |
| **Local web dashboard** | Fleet / project / cycle / inbox / session-tail views from local state; not hosted, no telemetry. | Ships **in this repo** — `generalstaff serve --open` (default `127.0.0.1:3737`; README Observability) | **No** — optional |
| **Aides** | Optional registry of persistent, credential-holding agents (a bot on another machine, a hosted personal agent): doors for messages, local inboxes as the record, `generalstaff aides …` commands, a read-only dashboard section. GeneralStaff never holds their credentials; their code goes through the normal gate. | Ships **in this repo**; off until you create `aides.yaml` (see `docs/AIDES.md`) | No |
| **Hammerstein** | Companion strategic-reasoning / reviewer-framework CLI for work *before* the queue (`h audit`, `h next`, `h worth`); also wired opt-in as advisor / judgment gate. GeneralStaff gates execution; Hammerstein audits the plan. | Separate project: [github.com/lerugray/hammerstein](https://github.com/lerugray/hammerstein) (README Strategic-reasoning companion; site footer “built on Hammerstein”) | **No** — companion; advisor/judgment_gate opt-in |

## Mode behavior (push / merge / audit)

These statements follow the implementation, including
[`dispatchItem`](../src/autonomous_session.ts),
[`executeCycle`](../src/cycle.ts), and
[session-end merging](../src/session.ts). They replace the earlier unresolved
comparison of README quotations.

| Mode | Local branch behavior | Remote behavior |
| --- | --- | --- |
| Manually queued cycle (`gs cycle`) | Works on the configured bot branch. With `auto_merge: true`, cycle preflight merges accumulated bot-branch work into the project checkout’s current `HEAD`. | No built-in dispatcher push stage. Configured engineer commands, provider tools and Git hooks can have their own remote effects. |
| Session (`gs session`) | Uses the same cycle policy and also attempts a final merge for eligible projects with `auto_merge: true`. | Same command/provider/hook boundary as a cycle. |
| Autonomous preview (`gs autonomous`) | Surveys and classifies work and records decisions; does not dispatch an engineer cycle. | May call configured survey/reasoning providers; it is not an offline mode. |
| Autonomous execution (`gs autonomous --execute`) | Passes the project configuration into the normal cycle, including `auto_merge`. It does not force that setting off. | Same command/provider/hook boundary as a cycle; no separate remote-push stage. |

`auto_merge` defaults to `false` in the
[project configuration loader](../src/projects.ts). Leave it false when every
local merge must be manual. Turning it on authorizes automatic **local** merges
into the checkout’s current branch; it is not a remote-push option.

Cycle bookkeeping can create local commits of `state/` in the GeneralStaff
checkout. Cycle evidence is recorded in `state/<project>/PROGRESS.jsonl` and its
related artifacts. Autonomous decision/dispatch ledgers track work for review;
a ledger entry does not itself prevent a merge or constrain provider Git access.

## Version compatibility

| Component | Version / note |
| --- | --- |
| GeneralStaff CLI (this repo) | **0.15.0** (`package.json` `"version"`) |
| GeneralStaff Desktop | See Desktop repo — not derivable from this tree |
| Local web dashboard | Same tree / same release as the CLI above (`serve`) |
| Hammerstein | Separate release train — see Hammerstein repo |
