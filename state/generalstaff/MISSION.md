# GeneralStaff — Mission (dogfooding context)

GeneralStaff is an open-source autonomous engineering dispatcher.
This state directory exists because GeneralStaff is its own first
test project — dogfooding.

The bot works on the bot/work branch in a .bot-worktree directory,
isolated from the main working tree on master. The human (Ray) and
interactive Claude sessions work on master in the main directory.

## Bot scope (what the autonomous bot can work on)

- Bug fixes surfaced by test cycles
- Test coverage improvements
- Code quality improvements (types, error handling)
- Documentation improvements to code comments
- Small features from the tasks.json backlog

## Bot scope exclusions (hands-off)

- Design documents (DESIGN.md, PIVOT, RULE-RELAXATION, PHASE-1-*, FUTURE-DIRECTIONS, UI-VISION, LAUNCH-PLAN, VOICE)
- Project conventions (CLAUDE.md, INDEX.md, README.md)
- Safety-critical modules (src/safety.ts, src/reviewer.ts, src/prompts/)
- Bot launcher scripts (scripts/, run_bot*, run_session*)
- Hammerstein logs (docs/internal/)
- Session notes (docs/sessions/)
- The hands-off list itself (projects.yaml, projects.yaml.example)

The autonomous bot does correctness work. Design and strategy
decisions stay with Ray.
