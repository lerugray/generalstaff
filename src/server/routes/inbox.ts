// GeneralStaff — Phase 6 route handler: GET /inbox (gs-286).
//
// Server-renders the cross-project fleet inbox. Reads the grouped
// message data assembled by src/views/inbox.ts and emits one section
// per local-date group with a timestamp, sender, kind, body, and
// links to referenced cycles. Follows gs-269's layout() pattern;
// mounted from src/server.ts.

import {
  getInboxView,
  InboxError,
  type InboxData,
  type InboxGroup,
  type InboxMessage,
  type InboxRef,
} from "../../views/inbox";
import { layout } from "../templates/layout";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function renderRefs(refs: InboxRef[]): string {
  if (refs.length === 0) return "";
  const parts: string[] = [];
  for (const ref of refs) {
    if (ref.cycle_id) {
      parts.push(
        `<a href="/cycle/${escapeHtml(ref.cycle_id)}"><code>${escapeHtml(ref.cycle_id)}</code></a>`,
      );
    }
    if (ref.session_id) {
      parts.push(
        `<a href="/tail/${escapeHtml(ref.session_id)}"><code>${escapeHtml(ref.session_id)}</code></a>`,
      );
    }
    if (ref.task_id) {
      parts.push(`<code>${escapeHtml(ref.task_id)}</code>`);
    }
  }
  if (parts.length === 0) return "";
  return `<span class="inbox-refs">${parts.join(" ")}</span>`;
}

function renderMessage(msg: InboxMessage): string {
  const kindTag = msg.kind
    ? `<span class="inbox-kind inbox-kind-${escapeHtml(msg.kind)}">${escapeHtml(msg.kind)}</span>`
    : "";
  return `<li class="inbox-message inbox-from-${escapeHtml(msg.from_type)}">
<span class="inbox-time"><time datetime="${escapeHtml(msg.timestamp)}">${escapeHtml(formatTime(msg.timestamp))}</time></span>
<span class="inbox-from">${escapeHtml(msg.from)}</span>
${kindTag}
<span class="inbox-body">${escapeHtml(msg.body)}</span>
${renderRefs(msg.refs)}
</li>`;
}

function renderGroup(group: InboxGroup): string {
  const headingId = `inbox-group-${group.date_iso}`;
  const items = group.messages.map(renderMessage).join("");
  return `<section class="panel inbox-group" aria-labelledby="${headingId}">
<h3 id="${headingId}"><span class="inbox-date-label">${escapeHtml(group.date_label)}</span> <span class="inbox-date-iso">${escapeHtml(group.date_iso)}</span></h3>
<ul class="inbox-list">${items}</ul>
</section>`;
}

function renderEmpty(): string {
  return `<section class="panel" aria-labelledby="inbox-empty-heading">
<h2 id="inbox-empty-heading">Inbox</h2>
<p class="empty">Inbox empty — all projects running clean.</p>
</section>`;
}

function renderHeader(data: InboxData): string {
  return `<section class="panel" aria-labelledby="inbox-heading">
<h2 id="inbox-heading">Inbox</h2>
<dl class="inbox-meta">
<dt>Messages</dt><dd>${data.unread_count}</dd>
<dt>Oldest shown</dt><dd><code>${escapeHtml(data.oldest_shown)}</code></dd>
<dt>Rendered</dt><dd><code>${escapeHtml(data.rendered_at)}</code></dd>
</dl>
</section>`;
}

export async function renderInboxPage(): Promise<{ status: 200 | 500; html: string }> {
  let data: InboxData;
  try {
    data = await getInboxView();
  } catch (err) {
    if (err instanceof InboxError) {
      const body = `<section class="panel" aria-labelledby="inbox-error-heading">
<h2 id="inbox-error-heading">Inbox unavailable</h2>
<p>${escapeHtml(err.message)}</p>
</section>`;
      return {
        status: 500,
        html: layout({
          title: "GeneralStaff — inbox (error)",
          activeNav: "inbox",
          body,
        }),
      };
    }
    throw err;
  }

  const body =
    data.groups.length === 0
      ? renderEmpty()
      : `${renderHeader(data)}
${data.groups.map(renderGroup).join("\n")}`;

  return {
    status: 200,
    html: layout({
      title: "GeneralStaff — inbox",
      activeNav: "inbox",
      body,
    }),
  };
}
