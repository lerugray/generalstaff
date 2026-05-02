#!/usr/bin/env bash
# GeneralStaff — one-command installer for macOS / Linux.
#
# Usage:
#
#   # Fresh install from scratch (clones into ./GeneralStaff/):
#   curl -fsSL https://raw.githubusercontent.com/lerugray/generalstaff/master/install.sh | bash
#
#   # Install into a specific directory:
#   GENERALSTAFF_DIR=/opt/generalstaff \
#     curl -fsSL https://raw.githubusercontent.com/lerugray/generalstaff/master/install.sh | bash
#
#   # Skip bun auto-install if you want to install it yourself:
#   GENERALSTAFF_NO_BUN_INSTALL=1 bash install.sh
#
# What this does, in order:
#   1. Verifies git is on PATH (fails clearly if not — git is not auto-installed)
#   2. Checks for bun; installs it via bun.sh/install if missing (opt out via env)
#   3. Clones the GeneralStaff repo to $GENERALSTAFF_DIR (default: ./GeneralStaff)
#      — or, if already cloned there, updates it with `git pull --ff-only`
#   4. Runs `bun install` inside the clone
#   5. Writes a `gs` shim to ~/.local/bin (or ~/bin) that resolves to
#      this install — `gs <subcommand>` works from anywhere on PATH.
#   6. Prints next steps — `gs welcome` for the first-run wizard.
#
# What this does NOT do:
#   - No sudo. Installs only into directories the user owns.
#   - No system-wide install. The `gs` shim lives in your home dir.
#   - No registering projects. That's the user's first real step.
#   - No launching sessions. `gs welcome` walks you through one;
#     `gs doctor` validates a manual setup.
#
# Safe to re-run. Idempotent where possible: re-runs update the clone,
# skip already-installed bun, and re-verify the install layout.

set -euo pipefail

# ------------------------------------------------------------
# Configuration (env-overridable)
# ------------------------------------------------------------

: "${GENERALSTAFF_DIR:=$(pwd)/GeneralStaff}"
: "${GENERALSTAFF_REPO:=https://github.com/lerugray/generalstaff.git}"
: "${GENERALSTAFF_BRANCH:=master}"
: "${GENERALSTAFF_NO_BUN_INSTALL:=}"

# ------------------------------------------------------------
# Pretty output helpers
# ------------------------------------------------------------

if [[ -t 1 ]] && [[ -z "${NO_COLOR:-}" ]]; then
  COLOR_RESET=$'\033[0m'
  COLOR_GREEN=$'\033[0;32m'
  COLOR_BLUE=$'\033[0;34m'
  COLOR_YELLOW=$'\033[0;33m'
  COLOR_RED=$'\033[0;31m'
  COLOR_DIM=$'\033[2m'
else
  COLOR_RESET=""
  COLOR_GREEN=""
  COLOR_BLUE=""
  COLOR_YELLOW=""
  COLOR_RED=""
  COLOR_DIM=""
fi

info()    { printf '%s[info]%s  %s\n' "${COLOR_BLUE}"   "${COLOR_RESET}" "$*"; }
ok()      { printf '%s[ ok ]%s  %s\n' "${COLOR_GREEN}"  "${COLOR_RESET}" "$*"; }
warn()    { printf '%s[warn]%s  %s\n' "${COLOR_YELLOW}" "${COLOR_RESET}" "$*"; }
fail()    { printf '%s[fail]%s  %s\n' "${COLOR_RED}"    "${COLOR_RESET}" "$*" >&2; exit 1; }
section() { printf '\n%s==%s %s\n'    "${COLOR_DIM}"    "${COLOR_RESET}" "$*"; }

# ------------------------------------------------------------
# Step 1 — git check
# ------------------------------------------------------------

section "Checking prerequisites"

if ! command -v git >/dev/null 2>&1; then
  fail "git is required but not installed. Install git first (e.g. 'brew install git' on macOS, 'apt install git' on Debian/Ubuntu), then re-run this installer."
fi
ok "git: $(git --version)"

# ------------------------------------------------------------
# Step 2 — bun check / install
# ------------------------------------------------------------

if ! command -v bun >/dev/null 2>&1; then
  if [[ -n "${GENERALSTAFF_NO_BUN_INSTALL}" ]]; then
    fail "bun is required but not installed, and GENERALSTAFF_NO_BUN_INSTALL is set. Install bun manually from https://bun.sh, then re-run."
  fi
  info "bun is not installed. Installing via https://bun.sh/install (this runs the upstream bun installer, not a GeneralStaff-maintained script)."
  # bun's own installer writes to $HOME/.bun by default. We do not
  # sudo; we do not touch system paths.
  curl -fsSL https://bun.sh/install | bash
  # bun.sh/install writes to ~/.bashrc etc. but the current shell
  # doesn't have the update. Source it for the rest of this script:
  if [[ -f "$HOME/.bun/bin/bun" ]]; then
    export PATH="$HOME/.bun/bin:$PATH"
  fi
  if ! command -v bun >/dev/null 2>&1; then
    fail "bun installed but is not on PATH. Open a new terminal and re-run this installer, or add ~/.bun/bin to your PATH manually."
  fi
fi
ok "bun: $(bun --version)"

# ------------------------------------------------------------
# Step 3 — clone or update the repo
# ------------------------------------------------------------

section "Preparing ${GENERALSTAFF_DIR}"

if [[ -d "${GENERALSTAFF_DIR}/.git" ]]; then
  info "Existing clone detected; running 'git pull --ff-only' to update."
  git -C "${GENERALSTAFF_DIR}" fetch --all --quiet
  git -C "${GENERALSTAFF_DIR}" pull --ff-only --quiet
  ok "Updated existing clone."
elif [[ -e "${GENERALSTAFF_DIR}" ]]; then
  fail "${GENERALSTAFF_DIR} exists but is not a git repo. Pick a different GENERALSTAFF_DIR or remove it first."
else
  info "Cloning ${GENERALSTAFF_REPO} → ${GENERALSTAFF_DIR}"
  git clone --branch "${GENERALSTAFF_BRANCH}" --quiet "${GENERALSTAFF_REPO}" "${GENERALSTAFF_DIR}"
  ok "Cloned."
fi

cd "${GENERALSTAFF_DIR}"

# ------------------------------------------------------------
# Step 4 — bun install
# ------------------------------------------------------------

section "Installing dependencies"
bun install --silent
ok "Dependencies installed."

# ------------------------------------------------------------
# Step 5 — install `gs` shim
# ------------------------------------------------------------

section "Installing gs shim"

# Pick a user-writable bin dir. ~/.local/bin is the XDG Base
# Directory convention; ~/bin is the older Unix convention. Prefer
# whichever already exists; create ~/.local/bin if neither does.
if [[ -d "$HOME/.local/bin" ]]; then
  SHIM_BIN_DIR="$HOME/.local/bin"
elif [[ -d "$HOME/bin" ]]; then
  SHIM_BIN_DIR="$HOME/bin"
else
  SHIM_BIN_DIR="$HOME/.local/bin"
  mkdir -p "$SHIM_BIN_DIR"
fi

SHIM_PATH="$SHIM_BIN_DIR/gs"

# Conflict detection: if a `gs` already exists, we only overwrite
# when it's a previous install.sh-generated shim pointing at *this*
# install dir (idempotent re-run). Any other case — a hand-written
# shim, a shim from a different GS install, an unrelated tool that
# happens to be named `gs` — is left untouched and the user is told
# how to resolve it. Silently overwriting an existing `gs` would be
# destructive: the user's previous install would stop working with
# no warning.
SHIM_ACTION="created"
SHIM_SKIP_REASON=""

if [[ -e "$SHIM_PATH" ]]; then
  # Two-step check: (a) is it an install.sh-generated shim at all?
  # We mark our shims with a fixed comment string that's unlikely to
  # collide with anything else. (b) does it point at *this* install?
  # We grep for the GS_HOME default literal. Any other case — a
  # hand-written shim, a shim from a different GS install, an
  # unrelated tool named `gs` — is left untouched.
  if grep -qF '# GeneralStaff CLI shim — generated by install.sh.' "$SHIM_PATH" 2>/dev/null; then
    if grep -qF "GS_HOME:-${GENERALSTAFF_DIR}}" "$SHIM_PATH" 2>/dev/null; then
      SHIM_ACTION="refreshed"
    else
      SHIM_ACTION="skipped"
      SHIM_SKIP_REASON="$SHIM_PATH points at a different GeneralStaff install. Remove it first if you want install.sh to manage it: rm \"$SHIM_PATH\""
    fi
  else
    SHIM_ACTION="skipped"
    SHIM_SKIP_REASON="$SHIM_PATH already exists and was not generated by install.sh. Remove it first if you want install.sh to manage it: rm \"$SHIM_PATH\""
  fi
fi

if [[ "$SHIM_ACTION" != "skipped" ]]; then
  # The shim is generated, not user-edited. Re-runs of install.sh
  # refresh the GS_HOME default so the shim always points at the
  # current install dir. Users who need to override the path can set
  # GS_HOME in their env.
  cat > "$SHIM_PATH" <<EOF
#!/usr/bin/env bash
# GeneralStaff CLI shim — generated by install.sh.
# Override GS_HOME to point at a different install.
GS_HOME="\${GS_HOME:-${GENERALSTAFF_DIR}}"
if [[ ! -f "\$GS_HOME/src/cli.ts" ]]; then
  echo "gs: GeneralStaff not found at \$GS_HOME (set GS_HOME to override)" >&2
  exit 1
fi
exec bun run --cwd "\$GS_HOME" src/cli.ts "\$@"
EOF
  chmod +x "$SHIM_PATH"
  ok "gs shim ${SHIM_ACTION}: $SHIM_PATH → ${GENERALSTAFF_DIR}"
else
  warn "gs shim skipped — $SHIM_SKIP_REASON"
fi

# Check that the shim dir is on PATH. If not, print the line the
# user needs to add to their shell rc — but don't edit rc files
# ourselves (too invasive; users who pipe-curl into bash would not
# expect their rc files to be touched).
if [[ ":$PATH:" != *":$SHIM_BIN_DIR:"* ]]; then
  warn "$SHIM_BIN_DIR is not on your PATH yet."
  warn "Add this line to your shell rc file (~/.zshrc, ~/.bashrc, etc.):"
  warn "    export PATH=\"$SHIM_BIN_DIR:\$PATH\""
  warn "Then open a new terminal, or run that export in your current shell."
fi

# ------------------------------------------------------------
# Step 6 — next steps
# ------------------------------------------------------------

section "Install complete"

cat <<EOF

${COLOR_GREEN}GeneralStaff is installed at:${COLOR_RESET}
  ${GENERALSTAFF_DIR}

${COLOR_BLUE}Quick start${COLOR_RESET} (recommended for new users):

  gs welcome

  The wizard walks you through provider setup, registers your
  first project, runs one verified cycle, and shows you the audit
  log. About 30 minutes total; nothing irreversible until each
  step's confirmation.

${COLOR_BLUE}Manual setup${COLOR_RESET} (if you'd rather configure by hand):

  1. Copy the example config:
       cp "${GENERALSTAFF_DIR}/projects.yaml.example" "${GENERALSTAFF_DIR}/projects.yaml"
       \$EDITOR "${GENERALSTAFF_DIR}/projects.yaml"

  2. Validate your setup:
       gs doctor

  3. Run your first session:
       gs session --budget=30 --dry-run

Docs:
  README.md                ${COLOR_DIM}# overview + quickstart${COLOR_RESET}
  CLAUDE.md                ${COLOR_DIM}# project conventions${COLOR_RESET}
  DESIGN.md                ${COLOR_DIM}# architecture${COLOR_RESET}
  docs/internal/           ${COLOR_DIM}# phase history, rule-relaxations, launch plan${COLOR_RESET}

The bot only ever pushes to ${COLOR_BLUE}bot/work${COLOR_RESET} on your own git remote.
Your code stays local; your API keys stay local. See Hard Rules in
CLAUDE.md.

EOF
