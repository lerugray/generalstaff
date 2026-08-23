# Compatibility & product surfaces

Single page for what a new reader otherwise has to reconstruct across
README, DESIGN, the marketing site, and this repo vs companion repos.
Facts below are grounded in those sources as of CLI **v0.13.0**
(`package.json`).

## Product surfaces

| Surface | What it is | Where it lives | Required? |
| --- | --- | --- | --- |
| **GeneralStaff CLI** | The engine: dispatcher, verification gate, cycle/session commands (`gs` / `generalstaff`). Install this first. | This repo (`github.com/lerugray/generalstaff`); `package.json` `bin` → `./src/cli.ts` | **Yes** — core product |
| **GeneralStaff Desktop (GSD)** | Optional local viewer/controller UI (fleet, workbench, live sessions). Hard Rule 2 permits a local desktop UI as viewer/controller; it is not the engine. | Separate repo: [github.com/lerugray/generalstaff-desktop](https://github.com/lerugray/generalstaff-desktop) (releases linked from `site/index.html`) | **No** — optional |
| **Local web dashboard** | Fleet / project / cycle / inbox / session-tail views from local state; not hosted, no telemetry. | Ships **in this repo** — `generalstaff serve --open` (default `127.0.0.1:3737`; README Observability) | **No** — optional |
| **Hammerstein** | Companion strategic-reasoning / reviewer-framework CLI for work *before* the queue (`h audit`, `h next`, `h worth`); also wired opt-in as advisor / judgment gate. GeneralStaff gates execution; Hammerstein audits the plan. | Separate project: [github.com/lerugray/hammerstein](https://github.com/lerugray/hammerstein) (README Strategic-reasoning companion; site footer “built on Hammerstein”) | **No** — companion; advisor/judgment_gate opt-in |

## Mode guarantees (push / merge / audit)

Rows derived from `README.md` and `DESIGN.md` only. Where those texts
disagree (or README disagrees with itself), the row is **UNRESOLVED**
with quotes — no inference from code.

### Manually queued cycle (`gs cycle` / `gs session` — work you queue)

| | Guarantee | Source |
| --- | --- | --- |
| **May be pushed** | Verified bot work may be pushed to the project’s `bot/work` branch on **your** git remote (nowhere else). Push is best-effort (can fail silently offline / auth-expired). | README: “Bot pushes to `bot/work` on your remote, nowhere else.”; Hard Rule 7; “Push is best-effort.” DESIGN: work stays on a per-project bot branch (not master). |
| **Never pushed** | Never push to `master` / `main` directly; user’s default branch stays untouched until **you** merge. No force-push / `--no-verify` / skipped hooks (DESIGN safety list). Auto-merge remains off until you opt in after clean cycles. | DESIGN: “Never push to master directly.” README: “Your `master` is untouched until you merge.”; Hard Rule 4 (auto-merge off by default). |
| **Preserved for audit** | Full prompts, responses, tool calls, and diffs in `state/<project>/PROGRESS.jsonl` (plus related cycle artifacts as the gate writes them). | README Hard Rule 9 / open audit log; DESIGN v2 open audit log (`PROGRESS.jsonl`). |

### Autonomous mode (`gs autonomous` / `--execute`)

| | Guarantee | Source |
| --- | --- | --- |
| **May be pushed** | **UNRESOLVED** — see quotes below. | README status line vs autonomous section vs Hard Rule 7 / “normal cycle”; DESIGN has no autonomous-specific remote-push rule (only “Never push to master directly”). |
| **Never pushed** | **UNRESOLVED** for *remote push of `bot/work`* (same conflict). **Agreed:** autonomous mode does not merge for you — merge stays your call; auto-merge / master is not the autonomous path’s job. | README: “never pushes or merges”; “the merge stays your call.” DESIGN: “Never push to master directly.” |
| **Preserved for audit** | Cycle audit still lands in `PROGRESS.jsonl` when work runs through the normal cycle. Autonomous **decision** and **dispatch** ledgers are local and gitignored (`gs forks` / `gs branches`). | README autonomous section; Hard Rule 9 / DESIGN `PROGRESS.jsonl`. |

#### UNRESOLVED — autonomous remote push

README describes autonomous dispatch as reusing the **normal cycle** (which elsewhere may push `bot/work`) **and** as never pushing:

> “Autonomous mode remains opt-in, default-off, and **never auto-pushes**.”  
> — README status blurb

> “Mechanical work is dispatched through the **normal cycle**. … It is … and **never pushes or merges**: dispatched work lands on the bot branch and in a review ledger (`gs branches`), and the merge stays your call.”  
> — README § Autonomous mode

> “Bot pushes to `bot/work` on your remote only.” / Hard Rule 7  
> — README (manual / hard-rules surface — same “normal cycle” rails)

DESIGN does not resolve the remote-push half:

> “Never push to master directly. Always work on a per-project bot branch.”  
> — DESIGN.md safety list

So: **merge-to-default-branch stays human** is consistent across README + DESIGN. Whether an autonomous `--execute` cycle may still **push `bot/work` to origin** (as a manually queued cycle may) is **not** settled by those two docs alone — mark unresolved until README/DESIGN are aligned.

## Version compatibility

| Component | Version / note |
| --- | --- |
| GeneralStaff CLI (this repo) | **0.13.0** (`package.json` `"version"`) |
| GeneralStaff Desktop | See Desktop repo — not derivable from this tree |
| Local web dashboard | Same tree / same release as the CLI above (`serve`) |
| Hammerstein | Separate release train — see Hammerstein repo |
