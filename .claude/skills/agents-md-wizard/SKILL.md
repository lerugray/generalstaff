---
name: agents-md-wizard
description: Interview-driven wizard that drafts AGENTS.md (the cross-platform agent-readable spec at https://agents.md) for any project. Type-branched question sets keep it project-neutral — works for business pitches, games, research, infra, side-hustles, personal tools, nonsense projects, and free-text "other". Use when registering a new project in GeneralStaff, when project scope is unclear, or when an existing AGENTS.md needs a refresh. Invoke as `/agents-md-wizard <project-path>` or `/agents-md-wizard <project-path> --type <type>` to skip type detection.
metadata:
  trigger: Drafting or refreshing AGENTS.md for a project
  outputs: AGENTS.md at project root, plus optional updates to existing AGENTS.md
---

# AGENTS.md Wizard

Interview the user about a project and write `AGENTS.md` at the project's
root. The artifact is the cross-platform standard at https://agents.md
(supported by Google, OpenAI, Cursor, Aider, Zed, et al). Project-neutral
framing — this works for satire, nonsense, side-hustles, and personal
tools, not just business pitches.

## When to invoke

- After registering a new project (in GeneralStaff or any project tracker)
- When an LLM agent keeps drifting from project intent because intent isn't
  captured anywhere agent-readable
- When a project pivots and `AGENTS.md` needs to reflect the new direction

## Argument

Required positional: project path (absolute path or relative to CWD).
Optional flags:
- `--type <type>` — skip the type-detection question; valid values:
  `business`, `game`, `research`, `infra`, `side-hustle`, `personal-tool`,
  `nonsense`, `other`
- `--update` — refresh an existing AGENTS.md; appends a dated revision
  block instead of overwriting (Phase B feature; for Phase A, just
  overwrite with a warning)

## Operational pattern

When invoked:

1. **Resolve project path.** If the argument is relative, resolve against
   user's CWD. Confirm the directory exists. If not, surface "Directory
   not found: <path>" and stop.

2. **Determine project type.**
   - If `--type <type>` was passed, use it.
   - Else, ask the user:
     ```
     What kind of project is this?
     1. business        — heavy interview (~12 questions, ~10 min)
     2. game            — heavy interview (~10 questions, ~8 min)
     3. research        — focused interview (~6 questions, ~5 min)
     4. infra           — focused interview (~5-7 questions, ~5 min)
     5. side-hustle     — light interview (~5-6 questions, ~4 min)
     6. personal-tool   — light interview (~4-5 questions, ~3 min)
     7. nonsense        — minimal (~3 questions, ~2 min)
     8. other           — free-text (you describe it however)
     9. skip            — write a stub AGENTS.md with TODO markers
     ```
   - Wait for response. Accept either the number or the name.

3. **Load question set.** Read
   `<skill-dir>/questions/<type>.json`. The file is an array of
   `{id, prompt, required}`. For `other` (empty file), prompt the user
   for free-text and skip the structured interview. For `skip`, render
   the template with all placeholders → "[TODO]" and stop.

4. **Conduct the interview.** For each question:
   - Display the prompt with a question number ("[3/12]")
   - Wait for the user's response in chat
   - Store the response keyed by `id`
   - For required questions, if the user gives an empty / "skip" response,
     re-ask once with a brief hint that the question is load-bearing for
     downstream agent context. After two declines, accept "[not specified]"
     and move on.
   - Don't editorialize the user's answers. Capture them verbatim
     (light formatting only — preserve whatever phrasing they use).

5. **Render the template.** Read
   `<skill-dir>/templates/agents-md.md`. The template has
   `{{placeholder}}` syntax with `||` fallback chains so a single template
   serves all types (a `nonsense` project produces a 3-section AGENTS.md
   because most placeholders fall through to "[not specified]" — which we
   then strip per the next rule).

6. **Light-type rendering rule.** For types `personal-tool` and
   `nonsense`, after rendering, REMOVE any sections whose body is exactly
   "[not specified]". Keep the section headings only when there's an
   actual answer. Other types render all 10 sections (with "[not
   specified]" placeholder for missing answers — surfaces the gap to the
   user).

7. **Write AGENTS.md.** Write the rendered content to
   `<project-path>/AGENTS.md`. If the file already exists:
   - Without `--update`: warn "AGENTS.md exists. Overwrite? (y/n)" and
     wait for response. On `n`, stop without writing.
   - With `--update`: read the existing file, prepend its current content
     under a `## Previous version (replaced YYYY-MM-DD)` section, then
     write the new content above. (Phase A keeps update mode simple;
     Phase B will add proper section-by-section diffing.)

8. **Confirm.** Report:
   ```
   Wrote: <project-path>/AGENTS.md
   Type: <type>
   Sections rendered: N of 10
   Universals captured: 3 of 3
   ```

## Type-specific notes

- **business** — ask all 12 in order. The 3 universals first, then the
  business-specific 9. Don't restate the user's answers in business
  jargon; preserve their voice.
- **game** — same pattern, 10 questions. Genre + reference games is the
  most load-bearing for agent context downstream.
- **research** — 6 questions. The hypothesis question often produces a
  vague answer; if so, gently prompt for "the actual question you want
  answered" rather than the abstract framing.
- **infra** — 7 questions (3 universal + 4). Constraints question is
  load-bearing — push for specific budget/latency/compliance numbers if
  the user gives vague answers.
- **side-hustle** — 6 questions. The "what would make you abandon this"
  question often produces the most useful answer for downstream
  scope-creep prevention.
- **personal-tool** — 5 questions. Short. Don't pad.
- **nonsense** — 3 questions only. The whole point of this type is to
  capture intent for projects that aren't supposed to be Real Business™.
  A satire project, an experimental art piece, a deliberate joke — all
  valid. Capture the actual intent in the user's voice.
- **other** — free-text. Ask: "Describe this project in your own words —
  what it is, what it isn't, when it's done, anything else relevant."
  Render that single response as the entirety of section 1.

## Behavioral guardrails

- **Don't restate the user's answers back to them.** They typed them,
  they know what they said. Move to the next question.
- **Don't editorialize in AGENTS.md.** The user's voice is the right
  voice. Light formatting only (markdown bullet lists, paragraph breaks).
- **Don't add sections the template doesn't have.** AGENTS.md is a
  standard format; don't invent custom sections.
- **Don't run the interview if the user just wants to inspect.** If the
  argument is `--help` or no project path is given, print usage and
  stop. Don't accidentally start a 12-question interview because the
  user typed `/agents-md-wizard` to see what it does.

## What this skill does NOT do

- Doesn't read the project's existing files to "infer" answers. The
  point is to capture what the USER wants the project to be — which may
  differ from what the code currently looks like. Inferring from code
  would just describe the past.
- Doesn't ship to the AGENTS.md website or any external system.
- Doesn't modify project files other than `AGENTS.md` itself.
- Doesn't run tests, builds, or any verification on the target project.

## Phase A scope

This is Phase A: register-time wizard, writes AGENTS.md, no reviewer
integration. Phase B will wire AGENTS.md into the GeneralStaff reviewer
as a soft alignment check (`verified_misaligned` verdict). Phase C+ adds
proactive drift detection. None of those exist yet — Phase A's
deliverable is just the artifact and the interview.
