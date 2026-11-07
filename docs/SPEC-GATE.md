# Spec-anchor gate

The spec-anchor gate checks one question before a task runs: does this task build what the owner asked for?

It is opt-in per project and off by default. With `spec_gate: off` nothing runs and nothing changes.

## Why it exists

An autonomous fleet can build software that has little to do with what its owner asked for. The owner's request passes through layers: a spec, plan milestones, task cards, lanes, reviews. Each layer checks the layer above it, never the owner's words. A stand-in that enters once passes every later review.

Two shapes recur.

1. **Drift through layers.** A task builds a rehearsal, a demo, a narrower product or a person-in-the-loop in place of the product the owner described. Every review passes it because each one compares against the plan, not the owner.
2. **Mangled features.** The owner asks for an experience, for example "make these games playable in the normal mode". The fleet builds an easier stand-in: a panel of setup fields, tables and dropdowns, manual bookkeeping, technical vocabulary where the owner described the software doing the work. Often the stand-in entered as a multiple-choice pick made from option labels, without a picture, and later layers then treated the pick as the owner's ruling.

The judgment gate (`docs/JUDGMENT-GATE.md`) asks whether a task is load-bearing or slop. It never reads the owner's spec. This gate adds the missing check against the owner's words.

## The anchor: SPEC.md

The anchor is a file at the project root, `SPEC.md` by default. Build it only from the owner's own words, and cite the source of each line.

- Line 1 is one sentence in the owner's words saying what the software does for its user.
- Then the steps the user takes, in order.
- Then an "Out of spec" list: stand-ins, person-in-the-loop work, narrower products, anything the owner rejected.

A short example is in `examples/spec-gate/SPEC.md.example`. For client work, the anchor holds the client's words.

The gate reads only the anchor and the card (title, description, owner words, a few flags). It does not read the plan, other tasks, or the code.

Put the anchor and every `owner_docs` file in the project's `hands_off` list. The engineer works in the same tree, and a missing anchor makes the gate warn and proceed, so an anchor the bot can edit or delete is a gate the bot can switch off. The anchor must sit inside the project; one that resolves outside it (through a symlink, say) is not read and counts as missing.

## Configuration

In `projects.yaml`, per project:

```yaml
spec_gate: block            # off | flag | block   (default: off)
spec_anchor: SPEC.md        # path inside the project (default: SPEC.md)
owner_docs:                 # owner-approved design docs whose exact quotes count as owner words
  - docs/GDD.md
picture_first: false        # true: see "Picture first" below
```

`spec_anchor` and every `owner_docs` entry must be relative paths that stay inside the project.

## Task fields

All optional, on greenfield tasks in `tasks.json`:

| Field | Meaning |
| --- | --- |
| `user_facing` | `true` when the task adds a new user-facing feature, mode or screen, or reshapes how one works. |
| `owner_words` | The owner's own sentence or sentences for this feature, verbatim. A string or a list of strings. For client work, the client's own words. |
| `owner_quote` | `{ text, source }`: an exact quote from an `owner_docs` file. `source` is `path#section`. |
| `first_screen` | Relative path to an image or HTML file showing the first screen. Used with `picture_first`. |

A free-text card (for the CLI path) can also carry a line `OWNER-ASK: "<words>"`. That line counts as owner words.

`owner_quote` is checked mechanically. The file must be listed in `owner_docs`, it must exist inside the project, and `text` (at least 10 characters) must occur verbatim in it once whitespace is normalised. A quote that is not found does not count, and the reason is recorded. A paraphrase never counts.

Set `user_facing` only on build cards. A verify or ship card marked `user_facing: true` is held to the owner-words rule too. A fix that restores approved behaviour is not marked `user_facing`, so the mechanical owner-words and `picture_first` checks do not apply to it; the checker still judges it against the anchor. The gate never reads a fix exemption from a task's title. Owner words need at least three words: "yes" is not a sentence for a feature.

## What the gate decides

The checker decides the KIND of work first:

- `build`: adds or changes software.
- `verify`: reviews, test-plays or accepts something that exists. It is never marked down for producing no change.
- `ship`: packaging and release steps.

Then it gives one verdict.

- **ON-SPEC.** After the work, the anchor's user gets more of the anchored product. That covers a feature the anchor describes or clearly implies, polish the user can see, reliability of something the anchor describes, and groundwork that names the later user-visible step it unlocks.
- **OFF-SPEC.** The result is a stand-in, rehearsal or demo in place of the product; a person doing by hand what the software should do; a narrower or different product; something the anchor lists as out of spec; groundwork that names no user-visible step; or paperwork whose only reader is the process.
- **UNCLEAR.** The card does not say what its work is for.

The prompt tells the checker to assume the card has drifted until the card shows otherwise. The prompt is the bundled file `src/prompts/spec_gate.md`. It carries a version number, and the version is part of the cache key.

The reply is one JSON object: `kind`, `verdict`, `user_can` (one plain sentence on what the user can do afterwards), `anchor_step`, `reason`, `owner_words_present`, `stand_in`.

### Feature words

A user-facing build card must carry the owner's words for that feature. The gate checks this without calling the model. If `user_facing` is true and there are no owner words (a task field, an `OWNER-ASK` line, or a verified `owner_quote`), the verdict is UNCLEAR with the reason "no owner words for this feature".

When owner words are present, the checker compares the card against them. It returns OFF-SPEC with `stand_in: true` when the card gives the user an easier stand-in for the experience the owner described: forms, setup fields, tables, dropdown walls, manual bookkeeping, file shuffling, or technical vocabulary where the owner described the software doing the work. It also does this when the card builds from a derived spec step or a multiple-choice pick that disagrees with the owner's words. The owner's words win.

### Completion discipline

Only a response that stopped normally and holds a valid verdict counts. A timeout, a finish reason other than a normal stop, an empty reply, or a reply that does not match the schema is an `error` verdict. The same rule applies to the reviewer since v0.17.0. A backend that reports no finish reason at all is taken at its word when the reply is otherwise valid; a backend that reports one must report a normal stop.

## Modes

- `off`: the gate does not run.
- `flag`: run the gate, log the verdict, proceed.
- `block`: proceed only on ON-SPEC. OFF-SPEC, UNCLEAR and `error` skip the cycle. The cycle reason is `spec_gate_off_spec`, `spec_gate_unclear` or `spec_gate_error`. The gate fails closed.

If the anchor file does not exist, the gate logs a `no_anchor` warning and proceeds in every mode.

The gate runs as step 3c of a cycle, right after the judgment gate. It does not run under verify-only. Each check appends a `spec_verdict` event to `PROGRESS.jsonl` and prints one console line.

## Backend

The checker is the `spec_checker` role in `provider_config.yaml` (see `docs/provider-config-format.md`). When the role is not routed, the gate calls OpenRouter inline. The model comes from `GENERALSTAFF_SPEC_GATE_MODEL`, and defaults to the judgment gate's model. The key is `OPENROUTER_API_KEY`, from your own environment.

If a routed provider fails, the gate reports an `error` verdict. It does not switch to another backend by itself.

## Cache

Verdicts are appended to `state/<project>/spec_checks.jsonl`, one JSON line each: timestamp, task id, key, model, and the verdict fields. The key is the sha256 of the prompt version, the anchor text and the card text. A valid verdict for the same key is reused without a call. Changing the card, the anchor or the prompt version makes a new key. `error` verdicts are never cached.

## Override

A blocked card can proceed when there is a plainly wrong verdict or a checker outage:

```
GENERALSTAFF_SPEC_GATE_OVERRIDE="checker was down, card matches SPEC step 2" generalstaff cycle ...
generalstaff spec check --project <id> --task <id> --override "<reason>"
```

The reason is required and needs at least three words. It is logged as a `spec_override` event and a record in the cache file. An override never passes a verdict with `stand_in: true`. A co-seat turn cannot use an override.

## CLI

```
generalstaff spec check --project <id> --task <id> [--json] [--override "<reason>"]
generalstaff spec check --anchor <file> --card <file> [--json]
generalstaff spec audit --project <id> [--out <file>]
```

The second form is for cards that are not tasks, such as a brief handed to an outside lane or a co-seat.

`spec check` exit codes: 0 ON-SPEC, 3 OFF-SPEC, 4 UNCLEAR, 1 could not check, 2 bad usage. With no anchor file it prints a warning and exits 0.

## The six protections

The gate is one part of a set of protections. Each applies to the process around the gate. The first, third and sixth are enforced in code. The second is enforced where GeneralStaff records owner decisions. The fourth and fifth are documented practice.

### 1. The owner's words ride every card

The owner's words for a feature travel with the card as `owner_words`, an `OWNER-ASK` line or a verified `owner_quote`. A card built from a summary of a summary has already lost them. Enforced by the gate (see "Feature words").

A spec step derived from the owner's picks quotes the owner's original ask beside the pick. A review that finds them disagreeing stops the card.

### 2. Picks are not rulings

Engineering choices (API shape, file layout, libraries) are the fleet's call. Do not put them to the owner as multiple choice.

A product-shape choice the owner makes from a list of option labels, without seeing a picture, is a seat option. It is not an owner ruling. The fork ledger records this. When a decision is resolved, `resolution_kind` is `ruling` or `seat_option`:

```
generalstaff forks resolve <id> "<what was decided>" --owner-words "<the owner's quoted words>"
generalstaff forks resolve <id> "<what was decided>"
```

A resolution with at least three words of quoted owner words is stored as a `ruling`, and the words are kept with it. One without is stored as a `seat_option`. Asking for `--kind ruling` without owner words is refused. A co-seat turn cannot record a resolution.

Records that predate v0.18.0 have no `resolution_kind` and are unchanged.

### 3. Picture first

With `picture_first: true` on a project, a `user_facing` build task must carry `first_screen: <path>` pointing at an existing image or HTML file in the project. The owner has seen the first screen before it is built. A missing field or a path that does not exist gives UNCLEAR with the reason "no first-screen picture", without a model call. In `block` mode that refuses the task. Tasks not marked `user_facing` (fixes included) are not checked for it.

### 4. Looks judge intent, not just pixels

Any visual check quotes the owner's words and names the user. Its first question is "would that user get what the owner asked for?" A screen nobody asked for is a FAIL, however clean it looks. A template is in `examples/spec-gate/look-brief.md`. This is documented practice. GeneralStaff has no visual check of its own to attach it to.

### 5. Client issues in the client's own words

For client work, the issue list is what the client said. Put the client's words in `owner_words`. The fleet's own doubts are recorded as its own calls with a reason. They are never turned into questions for the client. This is documented practice.

### 6. Drift audit before a launch

Run `generalstaff spec audit --project <id> --out drift-audit.md` before any launch or go-live decision. The report lists every `user_facing` task, done and pending:

- its owner words, or `MISSING`;
- its latest spec verdict from the cache, marked stale when the card or anchor has changed since;
- any overrides;
- a blank "what a user sees now" column for the person running the audit.

The command exits 2 when a done user-facing task has no owner words or its latest verdict is OFF-SPEC or UNCLEAR. Put the report in front of the owner with the go question.

## How it composes with other checks

- **Judgment gate.** The judgment gate asks whether a task is slop. This gate asks whether it matches the owner's words. Both can run, in that order. Neither changes the other.
- **Reviewer.** The verification gate (Hard Rule 6) still decides whether a cycle is done. This gate runs before the engineer and does not replace it. A task can be ON-SPEC and still fail verification.
- **Hands-off and auto-merge.** Unchanged.
