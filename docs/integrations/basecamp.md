# Basecamp 4 integration

GeneralStaff includes a first-party setup helper for Basecamp 4. The
dispatcher does not depend on Basecamp — the integration is optional.
What it gives you is the plumbing so that a GeneralStaff-managed
project can read from Basecamp programmatically (threads, projects,
files, todos) without you hand-rolling the OAuth dance every time.

## Why

Most real teams coordinating around software already live in Basecamp
(or Asana / Linear / Jira / Notion — this is the first integration,
not the only planned one). "Your autonomous dispatcher can't see any
of that" is a ceiling far below what a human operator would accept.
This integration drops that ceiling by one concrete notch: your
GS-managed project can now pull Basecamp state into its own cycle
prompts, verification gates, or operator surfacing.

What it doesn't do: automatically post to Basecamp, automatically
consume Basecamp data in the dispatcher's decisions, or turn GS into
a Basecamp client. This is plumbing — what you build on top of it is
per-project.

## One-time setup

### 1. Register an OAuth app with 37signals

Go to
[launchpad.37signals.com/integrations](https://launchpad.37signals.com/integrations)
and click **Register one now**. Fill in the form:

| Field | Value |
|---|---|
| Name | Something identifying — e.g. `MyProject / GeneralStaff Integration` |
| Company | Your company name |
| Website | Any URL you control |
| Redirect URI | `http://localhost:8765/oauth` (exact string matters) |

You can register multiple apps if you want separate OAuth identities
per project. Most users need one.

Submit the form. 37signals returns a **client ID** and **client
secret** on the confirmation page. Copy both.

### 2. Seed the project's `.env`

In the directory where you want Basecamp access (typically one of
your GS-managed projects, not the GS repo itself), create or edit
`.env`:

```
BASECAMP_CLIENT_ID=...paste client id here...
BASECAMP_CLIENT_SECRET=...paste client secret here...
BASECAMP_REDIRECT_URI=http://localhost:8765/oauth
BASECAMP_USER_AGENT=YourProject Integration (you@example.com)
```

The `BASECAMP_USER_AGENT` value is required on every Basecamp API
call; they reserve the right to block unidentified traffic. Include
contact info so they can reach you if your integration misbehaves.

Make sure `.env` is in your project's `.gitignore`. These credentials
are scoped to your OAuth app but still shouldn't land in source
control.

### 3. Run the auth flow

```bash
cd path/to/your-project   # the dir whose .env has the credentials
generalstaff integrations basecamp auth
```

What happens:

1. Your default browser opens to a 37signals Launchpad page asking
   whether to authorize your app against your Basecamp account.
2. You approve (it's your own account authorizing your own app).
3. Launchpad redirects back to `http://localhost:8765/oauth` — GS has
   a tiny local server running there to catch the callback.
4. GS exchanges the verification code for access + refresh tokens,
   discovers which account(s) the tokens can see, and writes
   everything to `.env`.
5. Browser tab shows a "Success" page; CLI prints a summary.

If you have multiple Basecamp accounts (personal + business), GS
saves the first one by default and prints the others. If you picked
wrong, edit `BASECAMP_ACCOUNT_ID` in `.env` manually.

## Verify

```bash
generalstaff integrations basecamp projects
```

Lists every project the token can see. If nothing comes back,
either:

- your OAuth app wasn't approved for a Basecamp 4 account (re-run
  auth), or
- the account has no projects yet (add one in the Basecamp UI and
  retry).

Machine-readable form for scripting:

```bash
generalstaff integrations basecamp projects --json > projects.json
```

`whoami` dumps the authorization info (accounts + identity) — useful
when debugging "which account am I actually signed into":

```bash
generalstaff integrations basecamp whoami
```

## Token lifecycle

- **Access tokens expire every ~14 days.** GS auto-refreshes on every
  `projects` / `whoami` call — if the current access token is within
  60 seconds of expiry, it's refreshed via the stored refresh token
  and the new token is written to `.env`.
- **Refresh tokens last ~10 years** but 37signals can revoke them if
  your app misbehaves. If refresh stops working, re-run `auth`.
- **Neither token ever leaves your machine** except to authenticate
  with 37signals' Launchpad.

## Cross-machine setup

Each machine runs `auth` once — ~3 minutes per machine, browser flow.
Same OAuth app works from anywhere; only the tokens are per-machine.

Alternative: copy the `BASECAMP_ACCESS_TOKEN` / `BASECAMP_REFRESH_TOKEN`
/ `BASECAMP_ACCOUNT_ID` / `BASECAMP_TOKEN_EXPIRES_AT` lines between
`.env` files. Token refresh works regardless of which machine minted
them.

## Using the tokens in your own code

The integration exposes a thin TypeScript client. From a
GeneralStaff-managed TS/Bun project:

```ts
import {
  loadClientConfig,
  listProjects,
  get,
} from "generalstaff/src/integrations/basecamp/client";

const config = loadClientConfig(".env");

// High-level: list all projects
const projects = await listProjects(config);

// Low-level: any endpoint under /{account_id}/
// e.g. messages in project 46290740's message board
const messages = await get(
  config,
  `buckets/46290740/message_boards/1/messages.json`,
);
```

The `get()` primitive handles:

- Bearer-token authorization (auto-refreshed as needed)
- Required User-Agent header
- Link-header pagination for list responses
- 200-aware error handling (non-2xx throws with the response body)

For non-TS projects, use the tokens directly. The SKILL.md in
`.claude/skills/basecamp/` (copy from the GS examples) documents the
same pattern for Python / shell / other languages.

## Gotchas

- **Base URL is `https://3.basecampapi.com/{account_id}/` — with a
  trailing slash after the account id.** The 3 is a Basecamp API
  version marker; it does not change across Basecamp 3, 4, 5.
- **`status: "active"` on a project does not mean "someone is working
  on it."** It means "not archived, not trashed." Liveness requires
  checking per-project activity (latest message, recent todos, etc.).
- **Pagination via Link header, not query-param cursors.** Follow
  `Link: <url>; rel="next"` until absent. GS's `get()` does this for
  you on array responses.
- **`User-Agent` is load-bearing.** Basecamp's docs warn they'll
  block unidentified traffic; GS enforces this by refusing to make
  calls when `BASECAMP_USER_AGENT` is missing — set it in `.env`.

## What's not in the integration (yet)

- **Write operations** (posting messages, creating todos, uploading
  files). The OAuth scope allows them, but GS intentionally doesn't
  surface them in the CLI — write actions land on real threads that
  real people see. Add them in your own project's code if you need
  them, with explicit opt-in.
- **Higher-level endpoint helpers** (typed wrappers for threads,
  todos, documents, etc.). The `get()` primitive covers the common
  case; richer typed helpers can land incrementally as use cases
  emerge.
- **Web-hook receiver.** Basecamp supports webhooks; GS doesn't
  integrate with them yet. A future feature.

## Related docs

- Basecamp's own API docs: [github.com/basecamp/bc3-api](https://github.com/basecamp/bc3-api)
- Authentication section specifically: [bc3-api §authentication](https://github.com/basecamp/bc3-api/blob/master/sections/authentication.md)
- [`docs/conventions/usage-budget.md`](../conventions/usage-budget.md):
  capping how much of your Claude Code / OpenRouter / Anthropic API
  quota a GS session is allowed to spend. Uses the same `.env`
  pattern for provider keys (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`,
  etc.) that this integration uses for Basecamp credentials.
