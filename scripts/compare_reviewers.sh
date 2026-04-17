#!/usr/bin/env bash
# Wrapper: sources OPENROUTER_API_KEY from MiroShark's .env and runs
# the compare_reviewers.ts script against one or more cycle IDs.
#
# The MiroShark .env stores the OpenRouter key under the field name
# OPENAI_API_KEY (per Ray's global routing config). We extract just
# that single field — no other env is loaded — and invoke with the
# key scoped to the bun child process.
#
# Usage:
#   bash scripts/compare_reviewers.sh <cycleId1> [cycleId2...]

set -euo pipefail

ENV_FILE="/c/Users/rweis/OneDrive/Documents/MiroShark/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: expected provider .env at $ENV_FILE" >&2
  exit 1
fi

KEY_VALUE="$(grep -E '^OPENAI_API_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
if [ -z "$KEY_VALUE" ]; then
  echo "ERROR: OPENAI_API_KEY (OpenRouter key) not found in $ENV_FILE" >&2
  exit 1
fi

# Scope the export to the bun subprocess only.
OPENROUTER_API_KEY="$KEY_VALUE" bun scripts/compare_reviewers.ts "$@"
