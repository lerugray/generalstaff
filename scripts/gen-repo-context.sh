#!/usr/bin/env bash
# GeneralStaff — repo-structure orientation generator (feat/repo-context-dispatch)
#
# Usage: bash scripts/gen-repo-context.sh <repo_dir>
#
# Runs `aider --show-repo-map --map-tokens 700` inside <repo_dir> and, on
# success with a NON-EMPTY map, prints an orientation block to stdout that
# the dispatcher / GS-Desktop prepend to the engineer's prompt. The block
# gives the agent an instant structural map of the target repo (ranked
# tree-sitter + pagerank, no full-file reads) and tells it to FORM ITS OWN
# PLAN and proceed WITHOUT human plan-approval.
#
# SAFE FALLBACK (load-bearing — see DESIGN.md §repo-context-dispatch):
#   On ANY failure — aider missing, non-zero exit, empty/garbage map, or
#   the timeout firing — this script prints NOTHING and exits 0. The caller
#   captures stdout into a shell var; an empty var means dispatch proceeds
#   EXACTLY as it did before this feature existed. We NEVER inject an
#   empty/broken block, and we NEVER break dispatch.
#
# Why aider: it is ALREADY installed (it IS the GS engineer engine on the
# aider path), so this adds zero new dependency, and `--show-repo-map`
# emits a plain map STRING that works for every dispatch target (aider, the
# claude path which has MCP disabled, and GSD) without an MCP server.
#
# Note: aider's tree-sitter language coverage varies. For unsupported langs
# (e.g. GDScript) the map can come back empty — the safe fallback handles
# that gracefully (no injection), which is acceptable.

set -uo pipefail   # NOT -e: every failure path is handled explicitly and
                   # must still `exit 0` so dispatch is never broken.

REPO_DIR="${1:-}"

# --- Guard: a real directory must be given. -------------------------------
if [ -z "$REPO_DIR" ] || [ ! -d "$REPO_DIR" ]; then
  exit 0
fi

# --- Guard: aider must be on PATH. ----------------------------------------
if ! command -v aider >/dev/null 2>&1; then
  exit 0
fi

# Hard ceiling on wall-clock. aider's repo-map is ~2-3s on a mid repo, but
# a cold cache / huge tree could run long; we never let it stall a cycle.
TIMEOUT_SECS=30

# Portable timeout: prefer a real `timeout`/`gtimeout` if present (Linux,
# coreutils-on-Mac); otherwise fall back to a background + sleep + kill
# guard. macOS ships NEITHER `timeout` NOR `gtimeout` by default, so the
# fallback is the common path on Ray's Mac. The flags below are the set
# that makes aider print the map and exit cleanly in a NON-TTY context:
#   --no-fancy-input    : without this, aider (given no files) drops into
#                         an interactive prompt and crashes setting raw
#                         terminal mode on a non-TTY (OSError errno 22).
#   --no-show-model-warnings / --no-check-update : keep stdout to the map.
#   --no-pretty --no-stream : plain, capture-friendly output.
# Keep aider's side-effects OUT of the target repo. Without these flags,
# `aider --show-repo-map` writes `.aider.chat.history.md` + redirects its
# input/llm history into the repo, and will add `.aider*` to the repo's
# `.gitignore`. We redirect every history file into a throwaway temp dir
# and forbid aider from touching `.gitignore`:
#   --no-gitignore / --no-add-gitignore-files : never edit the repo's
#                                               .gitignore.
#   --*-history-file <tmp>                    : keep history out of the repo.
# The tags cache (`.aider.tags.cache.vN/`) has no relocation flag and lands
# in the repo root; we delete it best-effort after capture (see below).
AIDER_HIST="$(mktemp -d 2>/dev/null || echo "/tmp/gs-aiderhist-$$")"
mkdir -p "$AIDER_HIST" 2>/dev/null || true
# Exported so the `timeout`/`gtimeout` paths — which re-enter via
# `bash -c "$(declare -f run_aider); run_aider"` (a fresh shell) — still see
# it. The background-fallback path inherits it as a same-process subshell.
export AIDER_HIST

run_aider() {
  aider \
    --show-repo-map \
    --map-tokens 700 \
    --no-fancy-input \
    --no-pretty \
    --no-stream \
    --no-show-model-warnings \
    --no-check-update \
    --no-analytics \
    --no-gitignore \
    --no-add-gitignore-files \
    --chat-history-file "$AIDER_HIST/chat.md" \
    --input-history-file "$AIDER_HIST/input.md" \
    --llm-history-file "$AIDER_HIST/llm.md" \
    2>/dev/null
}

RAW=""
if command -v timeout >/dev/null 2>&1; then
  RAW="$(cd "$REPO_DIR" && timeout "${TIMEOUT_SECS}s" bash -c "$(declare -f run_aider); run_aider" 2>/dev/null)" || RAW=""
elif command -v gtimeout >/dev/null 2>&1; then
  RAW="$(cd "$REPO_DIR" && gtimeout "${TIMEOUT_SECS}s" bash -c "$(declare -f run_aider); run_aider" 2>/dev/null)" || RAW=""
else
  # Portable background + sleep + kill. Capture to a temp file so the
  # killer and the reader don't race on a pipe. Clean up unconditionally.
  TMP_OUT="$(mktemp 2>/dev/null || echo "/tmp/gs-repomap-$$.txt")"
  (
    cd "$REPO_DIR" || exit 0
    run_aider
  ) >"$TMP_OUT" 2>/dev/null &
  AIDER_PID=$!
  (
    sleep "$TIMEOUT_SECS"
    kill "$AIDER_PID" 2>/dev/null
  ) &
  WATCH_PID=$!
  wait "$AIDER_PID" 2>/dev/null
  AIDER_RC=$?
  # Tear down the watchdog whether or not it has fired.
  kill "$WATCH_PID" 2>/dev/null
  wait "$WATCH_PID" 2>/dev/null
  if [ "$AIDER_RC" -eq 0 ]; then
    RAW="$(cat "$TMP_OUT" 2>/dev/null)"
  fi
  rm -f "$TMP_OUT" 2>/dev/null
fi

# --- Clean up aider's repo-local side-effects (best-effort). --------------
# The history files were redirected to $AIDER_HIST (deleted here). The tags
# cache (.aider.tags.cache.vN/) has no relocation flag and lands in the
# repo root regardless — remove it so the target tree stays pristine. We
# never want a GS map call to leave untracked .aider* litter in a live
# project repo (for .bot-worktree it's torn down anyway; this keeps GSD's
# live target repos clean too). All best-effort: failure here is ignored.
rm -rf "$AIDER_HIST" 2>/dev/null || true
rm -rf "$REPO_DIR"/.aider.tags.cache.* 2>/dev/null || true
rm -f  "$REPO_DIR"/.aider.chat.history.md \
       "$REPO_DIR"/.aider.input.history \
       "$REPO_DIR"/.aider.llm.history 2>/dev/null || true

# --- Extract just the map, stripping aider's banner + framing. ------------
# aider prints, in order:
#   1. a startup banner ("Using ... model", "Aider vX", model lines,
#      "Git repo: ...", "Repo-map: using N tokens ...");
#   2. a three-line framing preamble that ENDS with a line containing
#      "add them to the chat" ("Here are summaries ...", "Do not propose
#      ...", "If you need to edit any of these files, ask me to *add them
#      to the chat* first.");
#   3. THE MAP itself (ranked file -> signature tree).
# We drop everything up to and including the framing preamble's last line.
# aider's own "treat as read-only / ask to add to chat" framing is also
# dropped on purpose: it would conflict with our "form your own plan, edit
# freely within the task" instruction. If the framing marker is absent, the
# run didn't produce a real map -> treat as empty (no injection).
MAP=""
if [ -n "$RAW" ] && printf '%s' "$RAW" | grep -q 'add them to the chat'; then
  # Print everything strictly AFTER the framing line, then trim leading and
  # trailing blank lines.
  MAP="$(printf '%s\n' "$RAW" \
    | awk 'seen{print} /add them to the chat/{seen=1}' \
    | awk 'NF{found=1} found{print}' \
    | awk '{lines[NR]=$0} END{last=0; for(i=1;i<=NR;i++) if(lines[i]!~/^[[:space:]]*$/) last=i; for(i=1;i<=last;i++) print lines[i]}')"
fi

# --- Final guard: empty map -> inject nothing, exit clean. ----------------
if [ -z "$MAP" ]; then
  exit 0
fi

# --- Emit the orientation block. ------------------------------------------
# This is prepended near the TOP of the engineer prompt. The critical
# constraints (hands_off list, verification gate, the task) follow BELOW it
# in the caller's static prompt and remain prominent — the map is
# orientation, not a replacement for them. The self-plan paragraph is the
# backstop that honors Ray's "no human approval needed" intent while
# reaffirming that hands_off + the verification gate still bind.
cat <<EOF
## Repository structure (orientation)

${MAP}

## Form your own plan (no approval needed)
Use the map above to decide which files to read — you don't need to read everything. Form a short plan for THIS task (which files you'll touch, in what order), then proceed and execute it. You do NOT need anyone to approve your plan first. The map is a fast orientation, not authoritative — if it looks stale or incomplete, verify against the actual files before editing. The hands_off list and verification gate below still bind regardless of your plan.
EOF

exit 0
