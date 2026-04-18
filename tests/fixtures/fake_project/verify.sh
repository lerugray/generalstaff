#!/usr/bin/env bash
# Stub verification command for the gs-168 non-dogfood cycle integration test.
# Always exits 0; writes its CWD to a marker file so the test can prove
# verification ran inside the worktree under project.path.
set -e
echo "verification ran in $PWD"
if [ -n "$GS_TEST_VERIFY_MARKER" ]; then
  printf '%s\n' "$PWD" >> "$GS_TEST_VERIFY_MARKER"
fi
exit 0
