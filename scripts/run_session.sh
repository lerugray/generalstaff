#!/usr/bin/env bash
# GeneralStaff — session launcher (macOS / Linux).
#
# Mirrors scripts/run_session.bat for Windows. Runs `generalstaff session
# --budget=<min>` synchronously, tees output to logs/session_<ts>.log,
# writes digests/LAST_RUN.md as a pointer to the log + timestamped digest
# emitted by session.ts.
#
# Usage:
#   bash scripts/run_session.sh                   (6 hr, openrouter reviewer)
#   bash scripts/run_session.sh 300               (5 hr, openrouter reviewer)
#   bash scripts/run_session.sh 90 ollama         (90 min, local Ollama reviewer)
#   bash scripts/run_session.sh 120 claude        (2 hr, claude -p fallback)
#
# Reviewer providers (same as Windows launcher):
#   openrouter — Qwen3 Coder via OpenRouter (paid, ~$0.02/session; default)
#   ollama     — local Ollama server, qwen3:8b by default (free, offline)
#   claude     — claude -p (highest quality, uses Claude quota)
#
# OPENROUTER_API_KEY precedence (matches the .bat):
#   1. Already exported in the environment — used as-is.
#   2. OPENROUTER_ENV_FILE points at a .env-style file containing
#      OPENROUTER_API_KEY=... or OPENAI_API_KEY=... — first match wins.
#   3. Default path $HOME/.generalstaff/.env if it exists.
#   4. Missing — loud warning, cycles fail-safe to verification_failed.
#
# For launchd / cron automation, invoke as:
#   /bin/bash /path/to/GeneralStaff/scripts/run_session.sh 240
# (export PROJECT_ROOT first if the script's own resolution doesn't
# match the launcher's working-directory model.)

set -euo pipefail

# Resolve PROJECT_ROOT relative to this script's location. Override via
# env if needed: PROJECT_ROOT=/path/to/gs bash scripts/run_session.sh
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
: "${PROJECT_ROOT:=$(cd "$SCRIPT_DIR/.." && pwd)}"

BUDGET="${1:-360}"
PROVIDER="${2:-openrouter}"
export GENERALSTAFF_REVIEWER_PROVIDER="$PROVIDER"

# Ensure bun is on PATH. bun's installer adds ~/.bun/bin; honor that.
# git and claude (Anthropic CLI) are expected to be on PATH already.
if [[ -d "$HOME/.bun/bin" ]]; then
  export PATH="$HOME/.bun/bin:$PATH"
fi

cd "$PROJECT_ROOT"

mkdir -p logs digests

TS="$(date -u +%Y%m%d_%H%M%S)"
LOG="logs/session_${TS}.log"
export GENERALSTAFF_SESSION_LOG="$LOG"

# Provider-specific credential loading. OpenRouter needs an API key;
# Ollama and claude need nothing (Ollama → localhost:11434, claude -p
# uses its own subscription auth).
load_openrouter_key() {
  local env_file
  for env_file in "${OPENROUTER_ENV_FILE:-}" "$HOME/.generalstaff/.env"; do
    [[ -z "$env_file" ]] && continue
    [[ ! -f "$env_file" ]] && continue
    # Prefer OPENROUTER_API_KEY=...; fall back to OPENAI_API_KEY=...
    # (the Windows MiroShark .env uses the latter name historically).
    local key
    key="$(grep -E '^OPENROUTER_API_KEY=' "$env_file" | head -1 | cut -d= -f2-)"
    if [[ -z "$key" ]]; then
      key="$(grep -E '^OPENAI_API_KEY=' "$env_file" | head -1 | cut -d= -f2-)"
    fi
    if [[ -n "$key" ]]; then
      # Strip surrounding quotes if the file uses VAR="value" form.
      key="${key%\"}"
      key="${key#\"}"
      key="${key%\'}"
      key="${key#\'}"
      export OPENROUTER_API_KEY="$key"
      return 0
    fi
  done
  return 1
}

PROVIDER_LC="$(echo "$PROVIDER" | tr '[:upper:]' '[:lower:]')"
if [[ "$PROVIDER_LC" == "openrouter" ]] && [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  if ! load_openrouter_key; then
    cat >&2 <<EOF
WARNING: OPENROUTER_API_KEY not set and no .env file found.
         Checked:
           - OPENROUTER_ENV_FILE = ${OPENROUTER_ENV_FILE:-(unset)}
           - $HOME/.generalstaff/.env
         Reviewer will return 'REVIEWER ERROR' every cycle and
         fail-safe to verification_failed. Either:
           export OPENROUTER_API_KEY=sk-or-...
           export OPENROUTER_ENV_FILE=/path/to/.env
           create $HOME/.generalstaff/.env with OPENROUTER_API_KEY=...
         Or pass a different provider:
           bash scripts/run_session.sh $BUDGET ollama
           bash scripts/run_session.sh $BUDGET claude
EOF
  fi
fi

cat <<EOF
=== GeneralStaff session launcher ===
Root:     $PROJECT_ROOT
Started:  $TS
Budget:   $BUDGET min
Reviewer: $GENERALSTAFF_REVIEWER_PROVIDER
Log:      $LOG
======================================

EOF

{
  echo "=== GeneralStaff session launcher ==="
  echo "Root:     $PROJECT_ROOT"
  echo "Started:  $TS"
  echo "Budget:   $BUDGET min"
  echo "Reviewer: $GENERALSTAFF_REVIEWER_PROVIDER"
  echo "Log:      $LOG"
  echo "======================================"
  echo
} > "$LOG"

# Run session synchronously, append output to log. Disable -e around
# the bun invocation so we capture the exit code instead of aborting.
set +e
bun src/cli.ts session --budget="$BUDGET" >> "$LOG" 2>&1
EXITCODE=$?
set -e

ENDTS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cat > digests/LAST_RUN.md <<EOF
# GeneralStaff --- last run

**Ended:** $ENDTS
**Exit code:** $EXITCODE
**Budget:** $BUDGET min
**Log:** \`$LOG\`

See the timestamped digest in \`digests/\` for the per-cycle breakdown.
EOF

echo
echo "=== Session ended ==="
echo "Exit code: $EXITCODE"
echo "Log:       $LOG"
echo "Summary:   digests/LAST_RUN.md"

# End-of-session Telegram notification fires from session.ts itself
# (src/notify.ts) when the integration is wired up.

exit "$EXITCODE"
