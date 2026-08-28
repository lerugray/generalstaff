# GeneralStaff

[![Test](https://github.com/lerugray/generalstaff/actions/workflows/test.yml/badge.svg)](https://github.com/lerugray/generalstaff/actions/workflows/test.yml)

![GeneralStaff: a verification gate for autonomous coding agents. Your agent says the work is done; it doesn't get the last word. Open source, bring your own keys, full audit log.](docs/images/banner.png)

## In plain English

GeneralStaff lets you describe, in plain words, the software you want, then puts AI to work building it while you stay in charge. The catch with letting AI write code on its own is that it tends to report a job as finished when it isn't. GeneralStaff stops that. Before any work is accepted it has to pass a check: the tests must pass, real changes must exist, and a second AI has to confirm the work matches what was asked. If it fails, the work is thrown out instead of kept, and you can read a full record of everything the AI did.

The maintainer is a game designer with no coding background. He builds and runs GeneralStaff by directing AI in plain English rather than writing the code himself. The craft is in structuring the work and verifying it until you can trust the result. GeneralStaff itself was built that way.

**Verification-gate discipline for autonomous coding agents.**
**Your code. Your keys. Your audit log.**

## The wedge

Let an agent attempt bounded work. Deterministically reject changes that violate scope or fail project-authored evidence. Preserve everything needed to audit the decision.

The gate is code, not a prompt. Every cycle runs `verification_command` (your tests), checks the diff is non-empty, and asks a separate reviewer to confirm the diff matches the task and respects the `hands_off` list. Fail any of these and the cycle is rolled back. Every prompt, response, tool call, and diff is written to `state/<project>/PROGRESS.jsonl`.

## Install and run one cycle

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/lerugray/generalstaff/master/install.sh | bash
gs welcome
```

Windows: run `install.ps1` from the same URL, then `gs welcome`.

The installer clones into `./GeneralStaff/`, installs `bun` if it is missing, and writes the `gs` shim. `gs welcome` asks ~5 questions—provider, project path, verification command, files to protect—and runs one verified cycle end-to-end.

After the wizard, queue a task manually and run a single cycle:

```bash
gs task add --project=<id> "describe one concrete change"
gs cycle --project=<id>
cat state/<id>/PROGRESS.jsonl
```

The bot works in `.bot-worktree/` on a `bot/work` branch. Your `master` branch is untouched until you merge.

## What the gate catches

- Failed tests or a non-zero `verification_command`.
- Empty diffs reported as complete.
- Edits to files in the `hands_off` list.
- A diff that does not match the task's declared scope.

## What the gate does not catch

- **Scope-match is not correctness.** Tests are the correctness signal. If they pass for the wrong reason, the gate ratifies the cycle.
- **Pre-diff failures.** A missing toolchain, a bad worktree setup, or an engineer crash leaves nothing to verify. The gate cannot catch what never reached it.
- **Empty-diff streaks.** When the queue is thin the engineer may return `verified_weak` with no diff. Watch substantive landings, not raw cycle count.
- **Push is best-effort.** The gate runs at commit time. Pushing `bot/work` to your remote depends on auth and network; it can fail silently.

## Optional layers

These sit on top of the same gate. None are required to start.

- **Autonomous mode.** `gs autonomous` scopes and queues its own work, then routes it through the same verification gate. Default-off; the merge always stays your call. Exact per-mode push guarantees: [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md). Config: `projects.yaml.example`.
- **GeneralStaff Workbench.** The desktop surface for directing a GeneralStaff fleet in plain English. Choose a project and which AI should do the job, direct the work through conversation, answer decisions, and inspect the result. The GeneralStaff CLI remains the verification gate; Workbench does not accept work just because an agent says it is finished. It ships from the GeneralStaff Desktop repository as a thin Visual Studio Code extension and isolated profile, with code, diffs, previews, and a terminal available when needed. See [releases](https://github.com/lerugray/generalstaff-desktop/releases) and [source](https://github.com/lerugray/generalstaff-desktop).
- **Local dashboard.** `generalstaff serve --open` opens a fleet view at `127.0.0.1:3737`. No telemetry, no hosted tier.
- **Hammerstein.** A separate strategic-audit CLI for plans before they reach the queue. See [`docs/ADVISOR.md`](docs/ADVISOR.md) and [`docs/JUDGMENT-GATE.md`](docs/JUDGMENT-GATE.md). Compatibility notes for all layers: [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md).

## Origin

Named for Kurt von Hammerstein-Equord's officer typology: clever/stupid × industrious/lazy. The "general staff" quadrant handles execution on behalf of command. Confident officers without judgment sit in the stupid-industrious quadrant, where they cause unbounded damage. Autonomous coding agents without verification gates live there.

A wargame designer built this by treating AI failure modes as an adversarial rules problem: enumerate the bad outcomes, encode the defenses as Boolean checks, and keep a complete audit log. The result is a local, BYOK dispatcher that gates every cycle before it touches your main branch.

## Documentation

- [`QUICKSTART.md`](QUICKSTART.md) — step-by-step first cycle.
- [`SECURITY.md`](SECURITY.md) — key storage, threat model, limitations.
- [`DESIGN.md`](DESIGN.md) — architecture and hard rules.
- [`CHANGELOG.md`](CHANGELOG.md) — release notes.
- [`projects.yaml.example`](projects.yaml.example) — configuration schema.

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md). Correctness PRs welcome; taste-work PRs need a conversation first.

## License

[AGPL-3.0-or-later](LICENSE).
