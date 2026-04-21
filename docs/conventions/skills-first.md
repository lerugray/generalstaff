# Skills-first tool integration

GeneralStaff's convention for wiring external specialized tools
(design systems, browser automation, domain-specific analyzers,
data-processing pipelines) into a managed project.

## The pattern in one sentence

Integrate via a portable `SKILL.md` file that Claude Code reads
and respects, not by baking the tool into GeneralStaff core.

## Why this convention exists

Every external tool is tempting to build a first-party integration
for. Every first-party integration is a commitment — code to
maintain, docs to keep current, scope creeping from "autonomous
dispatcher" into "all-in-one workbench." The skills-first pattern
lets you use any external tool with a GS-managed project without
asking the GS maintainers to ship an integration first.

The pattern also matches how Claude Code itself works: sessions
pick up `SKILL.md` files from `.claude/skills/` and apply the
instructions in them. GS doesn't need to invent a plugin
architecture; the skills mechanism is already there.

## What goes in a SKILL.md

A `SKILL.md` is a single markdown file with optional YAML
frontmatter that tells Claude Code when to apply the skill and
how to use it. Typical shape:

```markdown
---
name: your-tool
description: One-line summary. Claude Code uses this to decide
  when the skill is relevant.
---

# Your tool — what it is

Brief explanation of what the tool does and when to reach for it.

## Setup state (if any)

Auth tokens, config paths, env vars — whatever a session needs to
know about the tool's current state on this machine.

## How to use

Concrete patterns. Endpoints, primitives, common tasks. The goal
is that a future session can pick up this file and know how to
operate the tool without re-discovering its shape.

## Do / don't

Guardrails. What the tool is for; what uses cross a line.
```

There is no strict schema. Claude Code agents read the file in
full; write it for another agent (or future-you), not for a
parser.

## Where SKILL.md lives

Three tiers, from most-scoped to least:

- **Per-project:** `<project-root>/.claude/skills/<skill-name>/SKILL.md`
  — the skill applies only when working in that project. This is
  the most common case. Example: a project-specific browser-
  automation setup lives under its own project's skills.

- **User-global:** `~/.claude/skills/<skill-name>/SKILL.md` — the
  skill applies in every Claude Code session run by that user.
  Appropriate for tools you use broadly across your work.

- **System:** Claude Code's defaults and plugin-provided skills —
  not user-authored in the normal course.

Files under `.claude/skills/` are discovered automatically by
Claude Code. No registration step in GS; no `plugin install`
command.

## How this plays with GeneralStaff

GS's dispatcher runs the bot cycle. The engineer prompt inside
each cycle is Claude Code, which sees whatever skills are
available to it. Therefore:

1. When you want the bot in project X to be able to use tool Y,
   drop `SKILL.md` for tool Y into `X/.claude/skills/Y/`.
2. The bot's next cycle has access to that tool's instructions
   automatically — no GS change needed.
3. If the tool needs credentials, put them in project X's `.env`
   and document in the `SKILL.md` that they live there.

This is how GS extends without becoming a plugin ecosystem. The
tool's build-out, upgrades, and deprecations happen in its own
repo; GS just hosts the project where the `SKILL.md` points.

## What GS itself does NOT do

- **No `generalstaff install <plugin>` command.** Skills are files,
  not runtime modules. Copying a `SKILL.md` into your project's
  `.claude/skills/` is the install step.
- **No dispatcher-level dependencies on any specific tool.** If
  your team's workflow needs Basecamp or Linear or Jira, drop
  the corresponding skill into your project. If someone else's
  workflow doesn't, their dispatcher runs unchanged.
- **No central skill registry.** Publish skills however you like
  — own repo, gist, company wiki, private share. The file is
  portable; the distribution is your choice.

## First-party integrations are the exception, not the rule

GS ships a small number of first-party integrations where the
setup cost is high enough that bundling it is genuinely useful.
Basecamp 4 is the first example (see
[docs/integrations/basecamp.md](../integrations/basecamp.md)):
the OAuth2 browser flow is fiddly enough that a one-command
`generalstaff integrations basecamp auth` is worth shipping.

But even the Basecamp integration is designed to complement the
skills-first pattern, not replace it. The CLI handles the auth
one-shot; the per-project `SKILL.md` (which you copy from the
example in the integration docs) tells your bot how to use the
resulting tokens.

## When to write a SKILL.md

- Whenever you set up an external tool against a GS-managed
  project and you want future sessions to pick it up without
  re-explanation.
- Whenever the setup has non-obvious state (auth tokens, config
  paths, machine-specific gotchas) that a fresh session wouldn't
  know.
- Whenever you've learned a domain-specific pattern (e.g.
  "this site's 'active' status doesn't mean what you think it
  does") that's useful to preserve.

## When NOT to write a SKILL.md

- For one-off scripts you'll run once and throw away.
- For obvious tools that any competent session would know how to
  use (standard git, standard curl, standard grep).
- For project conventions that belong in `CLAUDE.md` at the
  project root — `CLAUDE.md` is for "how to work on this
  project"; `SKILL.md` is for "how to use this specific tool."

## Example — the Basecamp skill shape

The first-party Basecamp integration documents the expected
skill structure users can copy into their own projects. See
`docs/integrations/basecamp.md` for the full pattern. In short:

```markdown
---
name: basecamp
description: Basecamp 4 API access for <your-project> — OAuth2
  bearer auth, read access to projects, threads, messages,
  documents, attachments. Tokens already provisioned.
---

## Tokens already exist
Auth flow is DONE. Secrets live in <project>/.env.

## Base URL
https://3.basecampapi.com/<account-id>/

## Request shape
[headers + pagination pattern]

## Do / don't
[guardrails]
```

Future sessions read this before writing any Basecamp code and
pick up the conventions automatically. That is the skills-first
pattern in practice.
