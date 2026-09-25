# Aides

An **Aide** is a persistent, named agent with its own memory, credentials, and delegated authority. It is neither a disposable GeneralStaff engineer for one cycle nor the operator. This layer is optional; `aides.yaml` is separate from `projects.yaml`.

## Protocol

1. Each Aide has one registered **door**: a local command, a file the Aide reads, or an HTTP endpoint. GeneralStaff sends messages through that door only. It does not reach into the Aide's machine by another route.
2. GeneralStaff does not use an Aide's own service credentials. `credential_scope` describes what the Aide can access; it contains no values. Credentials do not move between Aides without the operator's approval. If an HTTP door needs transport authentication, the operator supplies that distinct door token through a named environment variable.
3. The operator can task anyone. GeneralStaff can ask an Aide for work through its door, naming the registry `owner` as the operator when relaying a request. The Aide decides and records its decision in its inbox.
4. The owner of an overlapping surface declares ownership in an inbox row; the other agent stands down on that surface.
5. Evidence settles a disagreement. If evidence is inconclusive, the operator decides. Record the outcome in an inbox row.
6. Inbox rows are the audit trail. Treat consequential action without a row as unverified. Check claims about an Aide's own repo actions against the repo.
7. On retirement, keep the inbox as an archive and record where its surfaces were re-homed.
8. A new Aide needs a registry entry, an inbox file, and a handshake row before work begins.

## Set up

Copy [`aides.yaml.example`](../aides.yaml.example) to `aides.yaml`. Its two agents are fictional: Cinder reads a file door on another machine; Lumen is a hosted personal agent reached by a local command. Replace the command, owner, capabilities, scope, and hard lines for your own agents. `aides.yaml` and the root `aides/` directory are ignored by git because local inboxes may contain private data.

Create the declared inbox and file-door paths relative to the GeneralStaff root. For the example, make `aides/cinder-door.md`, `aides/cinder-inbox.md`, and `aides/lumen-inbox.md`. Replace `fictional-agent-client` with an installed client that reads the message from stdin and exits nonzero on failure. The file door receives Markdown request rows. An HTTP door uses `url` and optional `headers` mapping header names to environment variable **names**; it receives a JSON POST body with a `message` string. HTTP URLs cannot include user info, query parameters, or fragments. Keep actual authentication values in the operator's environment or the Aide's own environment, never in YAML.

Add a handshake row to each inbox before sending requests. An inbox is Markdown with rows of this form:

```markdown
## 2026-01-01 10:00 UTC Cinder: Handshake [ready]
- Door confirmed; Cinder reads its declared file.
- Surface ownership and hard lines acknowledged.
```

Use `generalstaff aides check` to validate the registry and local paths. Then:

```text
generalstaff aides list
generalstaff aides show Cinder
generalstaff aides say Cinder "Please review the proposed task"
generalstaff aides inbox Cinder --since 2026-01-01
generalstaff aides watch --json
```

`say` sends through the door, then appends an outbound row to the Aide's inbox. A successful command exit or HTTP response means only that the door accepted the request; it is not an Aide decision. The Aide or its bridge appends a separate decision row. `watch` prints rows added after it starts, once per observed row, and exits on Ctrl-C. The local dashboard shows each Aide's door type and five latest inbox rows.

## Security and scope

GeneralStaff never stores Aide credential values. The registry validator rejects values detected by the existing `redactSecrets` scanner, including planted credential-shaped tokens. For HTTP, the registry names environment variables; the runtime reads their values only to construct headers for that request. A command door receives the message on stdin and runs with an argv array, without shell interpolation. File doors are local paths. Choose a door and inbox location that only the intended parties can read or write.

An Aide-authored branch has no privileged path into a project. Queue or present its work through a normal GeneralStaff cycle so the project's tests, hands-off rules, scope review, and verification gate decide whether it lands. The Aide's inbox records its own actions and decisions; check consequential claims against the repo or other primary evidence.

This layer does not schedule Aides, borrow their credentials, make decisions for them, automatically ingest their remote memories, or bypass the normal project cycle. It does not provide a durable cross-process transaction: concurrent appends in one GeneralStaff process are serialized and atomically replaced, while independent processes need coordination if they write the same inbox at once.
