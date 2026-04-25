# agents-md-wizard

A Claude Code skill that drafts `AGENTS.md` (the cross-platform
agent-readable project spec at https://agents.md) for any project via
a short interactive interview.

## Why

LLM agents drift from project intent when intent isn't captured anywhere
agent-readable. CLAUDE.md captures *conventions*; this skill produces
the project-neutral *intent* artifact that the broader agent ecosystem
already reads.

## How

In any Claude Code session:

```
/agents-md-wizard /path/to/project
```

The wizard asks what kind of project this is, loads the matching
question set, runs the interview inline in your chat, and writes
`AGENTS.md` to the project's root when done.

To skip the type question:

```
/agents-md-wizard /path/to/project --type business
```

Valid types: `business`, `game`, `research`, `infra`, `side-hustle`,
`personal-tool`, `nonsense`, `other`, `skip`.

## Project-neutral framing

The 8 type branches keep the wizard usable for any project shape:

| Type | Question count | Use when |
|------|----------------|----------|
| business | 12 (3 universal + 9) | Real revenue plans, customer-facing products |
| game | 10 | Game projects, commercial or jam |
| research | 6 | Investigation, paper, dataset, exploratory work |
| infra | 7 | Backend services, dev infra, internal tools at scale |
| side-hustle | 6 | Smaller commercial projects, weekend builds |
| personal-tool | 5 | Just-for-me tools, scratch automation |
| nonsense | 3 (universals only) | Satire, art pieces, jokes, deliberate non-Real-Business |
| other | free-text | Doesn't fit anywhere; describe it your way |

The 3 universal questions every type asks:

1. What is this, in your own words?
2. What is this explicitly NOT?
3. When is this 'done' for you?

These are the load-bearing scope rails. Question 2 in particular tends
to be the most useful for downstream agent context — agents drift toward
adjacent features unless explicitly told what's out of scope.

## Output

The wizard writes a 10-section `AGENTS.md` at the project root. For
light types (`personal-tool`, `nonsense`), sections without answers are
omitted entirely (so a `nonsense` project gets a 3-section AGENTS.md,
not a 10-section one with 7 "[not specified]" stubs). For other types,
unanswered sections show "[not specified]" to surface the gap.

The output follows the cross-platform AGENTS.md standard at
https://agents.md so any agent that reads AGENTS.md (Cursor, Aider, Zed,
OpenAI Codex, Gemini, etc.) gets the same intent context.

## Update mode

```
/agents-md-wizard /path/to/project --update
```

Phase A behavior: prepends the existing AGENTS.md content under a
`## Previous version (replaced YYYY-MM-DD)` section, then writes the
new interview output above it. Phase B (planned) will do
section-by-section diffing and selective re-asking.

## Install

This skill ships in the GeneralStaff repo at
`.claude/skills/agents-md-wizard/`. Claude Code auto-loads it when you
run a session in this repo.

To use it from any project:

```bash
cp -r .claude/skills/agents-md-wizard ~/.claude/skills/
```

After that, the skill is available in every Claude Code session
regardless of CWD.

## Phase A scope

- ✅ Type-branched interview
- ✅ AGENTS.md output at project root
- ✅ Light-type section omission
- ✅ Update mode (basic — prepend old as "Previous version")
- ❌ Reviewer integration (Phase B)
- ❌ Drift detection (Phase C)
- ❌ Multi-project portfolio view (Phase D)
