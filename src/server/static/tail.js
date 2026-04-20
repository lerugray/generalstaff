// GeneralStaff — Phase 6 session-tail client (gs-285).
//
// Opens an EventSource against /tail/:sessionId/stream, appends one
// list item per JSONL event received, and surfaces connection state
// via the #tail-status paragraph the route's HTML renders. Vanilla JS,
// no framework, no build step — served straight from
// src/server/static/tail.js.

(function () {
  "use strict";

  var rootEl = document.getElementById("tail-root");
  var sessionId = rootEl ? rootEl.getAttribute("data-session-id") : null;
  var statusEl = document.getElementById("tail-status");
  var eventsEl = document.getElementById("tail-events");

  if (!sessionId || !statusEl || !eventsEl) {
    return;
  }

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = "tail-status " + cls;
  }

  function formatLabel(evt) {
    var parts = [];
    if (evt && evt.timestamp) parts.push(String(evt.timestamp));
    if (evt && evt.event) parts.push(String(evt.event));
    if (evt && evt.cycle_id) parts.push("cycle=" + evt.cycle_id);
    if (evt && evt.project_id) parts.push("project=" + evt.project_id);
    return parts.length > 0 ? parts.join(" · ") : "(event)";
  }

  function renderEvent(line) {
    var parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch (_err) {
      parsed = null;
    }
    var li = document.createElement("li");
    li.className = "tail-event";
    var label = document.createElement("div");
    label.className = "tail-event-label";
    label.textContent = parsed ? formatLabel(parsed) : "(unparseable line)";
    li.appendChild(label);
    var pre = document.createElement("pre");
    pre.className = "tail-event-body";
    pre.textContent = parsed ? JSON.stringify(parsed, null, 2) : line;
    li.appendChild(pre);
    eventsEl.appendChild(li);
  }

  var streamUrl = "/tail/" + encodeURIComponent(sessionId) + "/stream";
  var source = new EventSource(streamUrl);

  source.onopen = function () {
    setStatus("Connected — streaming events for " + sessionId, "tail-status-ok");
  };

  source.onmessage = function (e) {
    if (e && typeof e.data === "string" && e.data.length > 0) {
      renderEvent(e.data);
    }
  };

  source.onerror = function () {
    // EventSource auto-reconnects; surface the gap to the user rather
    // than silently accumulating stale state.
    setStatus(
      "Disconnected — browser will retry automatically.",
      "tail-status-error",
    );
  };
})();
