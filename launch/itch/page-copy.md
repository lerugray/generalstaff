# GeneralStaff — itch.io page copy

Page type: **Tool** (not a game). Cover: `launch/itch/cover.png` (630×500).
Banner (optional page header): `launch/itch/banner.png` (1200×400).
Download: GeneralStaff Desktop builds (macOS dmg + Windows installer). The
orchestrator itself lives on GitHub: https://github.com/lerugray/generalstaff

---

## Tagline (under the title, ~70 chars)

Autonomous coding agents that have to pass review before anything lands.

## Short description (search blurb, <600 chars)

GeneralStaff runs autonomous coding agents on your machine and gates every cycle. The tests pass, the diff is real, a separate reviewer confirms the change matches the task, and protected files stay untouched. Fail a gate and the work rolls back. You bring your own API keys and the full audit log stays local. The desktop console, included, shows every project's queue, cycle history, and live agent terminals in one window.

## Body (paste into the description box — prose, no headers)

Most setups for autonomous coding agents ask you to trust the agent. GeneralStaff assumes you shouldn't. It treats each agent cycle as adversarial input to your codebase. After the agent works, the tests have to pass, the diff has to be real, and a separate reviewer has to confirm the change did what the task asked. Files you mark off-limits stay off-limits; the dispatcher enforces that, and the agent works on a throwaway branch it can't merge by itself. A cycle that fails any check gets rolled back. Nothing reaches your main branch on trust alone.

You run it on your own hardware with your own API keys. There is no hosted layer, no credits, no account. Every cycle writes to a log on your machine, so you can read back what the agent changed and why.

GeneralStaff Desktop, the download here, is the cockpit. One window holds every project's task queue and cycle history, a per-project workbench with the file tree and a pings inbox, and live terminals running real Claude and Cursor sessions. It reads the fleet's state and lets you steer. It never writes to your code.

This is the engine behind a thirty-project portfolio, with a couple thousand of its own tests keeping it in line. Open source under AGPL, early, and built for people who want agents doing real work without breaking things behind your back. Desktop builds cover macOS and Windows; the orchestrator lives on GitHub.

**Where to go**

Get the desktop app: the download button above (macOS + Windows)
Source & docs: https://github.com/lerugray/generalstaff

(Paste the full https:// URL into itch so it auto-links. The GSD download is
the itch button once a build is uploaded; this link is the orchestrator + docs.)

## Tags (itch slugs)

ai, automation, programming, developer, productivity, open-source, tool, utilities

## Screenshots gallery (your call on redaction)

The real GSD cockpit screenshot shows the live fleet but lists every project
by name + internal notes. If you use it, crop out the macOS menu bar/dock and
consider blurring the sidebar project names + activity feed for anything
unreleased. Cover itself carries no private data.
