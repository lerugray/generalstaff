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
#   5. Prints next steps — copy projects.yaml.example, run `bun src/cli.ts doctor`
#
# What this does NOT do:
#   - No sudo. Installs only into directories the user owns.
#   - No global symlink of `generalstaff`. You run `bun src/cli.ts`
#     from the clone until a packaged binary ships (v0.2.0+).
#   - No registering projects. That's the user's first real step.
#   - No launching sessions. `doctor` is the first thing to run post-install.
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
# Step 5 — next steps
# ------------------------------------------------------------

section "Install complete"

cat <<EOF

${COLOR_GREEN}GeneralStaff is installed at:${COLOR_RESET}
  ${GENERALSTAFF_DIR}

${COLOR_BLUE}Next steps:${COLOR_RESET}

  1. Copy the example config and edit it for your first project:
       cd "${GENERALSTAFF_DIR}"
       cp projects.yaml.example projects.yaml
       \$EDITOR projects.yaml

  2. Run the doctor to validate your setup:
       bun src/cli.ts doctor

  3. Register a project (optional — the doctor will suggest this):
       bun src/cli.ts register --help

  4. Run your first session when you have one project set up:
       bun src/cli.ts session --budget=30 --dry-run

Docs:
  README.md                ${COLOR_DIM}# overview + quickstart${COLOR_RESET}
  CLAUDE.md                ${COLOR_DIM}# project conventions${COLOR_RESET}
  DESIGN.md                ${COLOR_DIM}# architecture${COLOR_RESET}
  docs/internal/           ${COLOR_DIM}# phase history, rule-relaxations, launch plan${COLOR_RESET}

The bot only ever pushes to ${COLOR_BLUE}bot/work${COLOR_RESET} on your own git remote.
Your code stays local; your API keys stay local. See Hard Rules in
CLAUDE.md.

EOF
