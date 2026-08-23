#!/usr/bin/env bash
# GeneralStaff — one-command installer for macOS / Linux.
#
# Usage:
#
#   # Fresh install from scratch (clones into ./GeneralStaff/,
#   # checks out the latest release tag by default):
#   curl -fsSL https://raw.githubusercontent.com/lerugray/generalstaff/master/install.sh | bash
#
#   # Install into a specific directory:
#   GENERALSTAFF_DIR=/opt/generalstaff \
#     curl -fsSL https://raw.githubusercontent.com/lerugray/generalstaff/master/install.sh | bash
#
#   # Pin (or override) the git ref — use master for tip-of-tree:
#   GENERALSTAFF_BRANCH=master bash install.sh
#   GENERALSTAFF_BRANCH=v0.12.0 bash install.sh
#
#   # Skip bun auto-install if you want to install it yourself:
#   GENERALSTAFF_NO_BUN_INSTALL=1 bash install.sh
#
#   # Non-interactive consent to add the shim directory to shell PATH:
#   GENERALSTAFF_UPDATE_PATH=yes bash install.sh
#
# What this does, in order:
#   1. Verifies git is on PATH (fails clearly if not — git is not auto-installed)
#   2. Checks for bun; installs it via bun.sh/install if missing (opt out via env)
#   3. Resolves the install ref: GENERALSTAFF_BRANCH if set, else the newest
#      v* release tag from the remote (via `git ls-remote --tags`)
#   4. Clones the GeneralStaff repo to $GENERALSTAFF_DIR (default: ./GeneralStaff)
#      — or, if already cloned there, fetches and checks out that ref
#   5. Runs `bun install --frozen-lockfile` inside the clone
#   6. Writes `gs` and `generalstaff` shims to ~/.local/bin (or ~/bin)
#      and, with confirmation, adds that directory to your shell PATH.
#   7. Prints next steps — `gs welcome` for the first-run wizard.
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
# GENERALSTAFF_BRANCH: optional explicit override (e.g. master, v0.12.0).
# When unset, the installer resolves the newest v* release tag below.
: "${GENERALSTAFF_NO_BUN_INSTALL:=}"
: "${GENERALSTAFF_UPDATE_PATH:=}"

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
# Step 3 — resolve install ref (latest release tag by default)
# ------------------------------------------------------------

section "Resolving install ref"

resolve_latest_release_tag() {
  # Newest v* tag from the remote. Uses git only (no gh / API dependency).
  # --refs skips peel refs (^{}) that annotated tags produce.
  git ls-remote --tags --refs "${GENERALSTAFF_REPO}" \
    | awk '{print $2}' \
    | sed 's#^refs/tags/##' \
    | grep -E '^v[0-9]' \
    | sort -V \
    | tail -n1
}

if [[ -n "${GENERALSTAFF_BRANCH:-}" ]]; then
  info "Using explicit GENERALSTAFF_BRANCH=${GENERALSTAFF_BRANCH}"
else
  info "GENERALSTAFF_BRANCH unset; resolving newest v* release tag from ${GENERALSTAFF_REPO}"
  GENERALSTAFF_BRANCH="$(resolve_latest_release_tag || true)"
  if [[ -z "${GENERALSTAFF_BRANCH}" ]]; then
    fail "Could not resolve a v* release tag from ${GENERALSTAFF_REPO}. Set GENERALSTAFF_BRANCH explicitly (e.g. GENERALSTAFF_BRANCH=master) and re-run."
  fi
  ok "Latest release tag: ${GENERALSTAFF_BRANCH}"
fi

# ------------------------------------------------------------
# Step 4 — clone or update the repo
# ------------------------------------------------------------

section "Preparing ${GENERALSTAFF_DIR}"

if [[ -d "${GENERALSTAFF_DIR}/.git" ]]; then
  info "Existing clone detected; fetching and checking out ${GENERALSTAFF_BRANCH}."
  git -C "${GENERALSTAFF_DIR}" fetch --all --tags --quiet
  git -C "${GENERALSTAFF_DIR}" checkout --quiet "${GENERALSTAFF_BRANCH}"
  # Branches stay tip-tracking; tags leave a detached HEAD at that release.
  if git -C "${GENERALSTAFF_DIR}" symbolic-ref -q HEAD >/dev/null 2>&1; then
    git -C "${GENERALSTAFF_DIR}" pull --ff-only --quiet
  fi
  ok "Updated existing clone to ${GENERALSTAFF_BRANCH}."
elif [[ -e "${GENERALSTAFF_DIR}" ]]; then
  fail "${GENERALSTAFF_DIR} exists but is not a git repo. Pick a different GENERALSTAFF_DIR or remove it first."
else
  info "Cloning ${GENERALSTAFF_REPO} @ ${GENERALSTAFF_BRANCH} → ${GENERALSTAFF_DIR}"
  git clone --branch "${GENERALSTAFF_BRANCH}" --quiet "${GENERALSTAFF_REPO}" "${GENERALSTAFF_DIR}"
  ok "Cloned."
fi

cd "${GENERALSTAFF_DIR}"

# ------------------------------------------------------------
# Step 5 — bun install (pinned lockfile)
# ------------------------------------------------------------

section "Installing dependencies"
if ! bun install --frozen-lockfile --silent; then
  fail "bun install --frozen-lockfile failed — the lockfile is out of sync with package.json at ref ${GENERALSTAFF_BRANCH}. Re-run with GENERALSTAFF_BRANCH=master to install from tip-of-tree, or wait for a release whose lockfile matches."
fi
ok "Dependencies installed."

# ------------------------------------------------------------
# Step 6 — install CLI shims
# ------------------------------------------------------------

section "Installing CLI shims"

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

install_shim() {
  local shim_name="$1"
  local shim_path="$SHIM_BIN_DIR/$shim_name"
  local shim_action="created"
  local shim_skip_reason=""

  # Only refresh install.sh-generated shims that already point at this
  # install. Never overwrite an unrelated command or another GS clone.
  if [[ -e "$shim_path" ]]; then
    if grep -qF '# GeneralStaff CLI shim — generated by install.sh.' "$shim_path" 2>/dev/null; then
      if grep -qF "GS_HOME:-${GENERALSTAFF_DIR}}" "$shim_path" 2>/dev/null; then
        shim_action="refreshed"
      else
        shim_action="skipped"
        shim_skip_reason="$shim_path points at a different GeneralStaff install. Remove it first if you want install.sh to manage it: rm \"$shim_path\""
      fi
    else
      shim_action="skipped"
      shim_skip_reason="$shim_path already exists and was not generated by install.sh. Remove it first if you want install.sh to manage it: rm \"$shim_path\""
    fi
  fi

  if [[ "$shim_action" == "skipped" ]]; then
    warn "$shim_name shim skipped — $shim_skip_reason"
    return
  fi

  # The shim is generated, not user-edited. Re-runs refresh GS_HOME so
  # both command names always resolve to the current install.
  cat > "$shim_path" <<EOF
#!/usr/bin/env bash
# GeneralStaff CLI shim — generated by install.sh.
# Override GS_HOME to point at a different install.
GS_HOME="\${GS_HOME:-${GENERALSTAFF_DIR}}"
if [[ ! -f "\$GS_HOME/src/cli.ts" ]]; then
  echo "${shim_name}: GeneralStaff not found at \$GS_HOME (set GS_HOME to override)" >&2
  exit 1
fi
exec bun run --cwd "\$GS_HOME" src/cli.ts "\$@"
EOF
  chmod +x "$shim_path"
  ok "$shim_name shim ${shim_action}: $shim_path → ${GENERALSTAFF_DIR}"
}

install_shim "gs"
install_shim "generalstaff"

# Check that the shim dir is on PATH. With explicit consent, append an
# idempotent block to the current shell's rc file. Curl-piped installs
# may not have a usable TTY; those get the exact manual command instead.
if [[ ":$PATH:" != *":$SHIM_BIN_DIR:"* ]]; then
  warn "$SHIM_BIN_DIR is not on your PATH yet."
  case "$(basename "${SHELL:-}")" in
    zsh)  SHELL_RC="$HOME/.zshrc" ;;
    bash) SHELL_RC="$HOME/.bashrc" ;;
    *)    SHELL_RC="$HOME/.profile" ;;
  esac
  PATH_LINE="export PATH=\"$SHIM_BIN_DIR:\$PATH\""
  PATH_CONSENT="$GENERALSTAFF_UPDATE_PATH"
  if [[ -z "$PATH_CONSENT" ]] && ( : </dev/tty ) 2>/dev/null; then
    printf 'Add GeneralStaff shims to PATH in %s? [y/N] ' "$SHELL_RC" >/dev/tty
    read -r PATH_CONSENT </dev/tty || PATH_CONSENT=""
  fi
  if [[ "$PATH_CONSENT" =~ ^[Yy]([Ee][Ss])?$ ]]; then
    if ! grep -qF '# GeneralStaff CLI shims' "$SHELL_RC" 2>/dev/null; then
      {
        printf '\n# GeneralStaff CLI shims\n'
        printf '%s\n' "$PATH_LINE"
      } >> "$SHELL_RC"
    fi
    ok "Added $SHIM_BIN_DIR to PATH in $SHELL_RC."
    warn "Open a new terminal, or run: $PATH_LINE"
  else
    warn "PATH was not changed. Add this line to your shell rc file:"
    warn "    $PATH_LINE"
    warn "Then open a new terminal, or run that export in your current shell."
  fi
fi

# ------------------------------------------------------------
# Step 7 — next steps
# ------------------------------------------------------------

section "Install complete"

cat <<EOF

${COLOR_GREEN}GeneralStaff is installed at:${COLOR_RESET}
  ${GENERALSTAFF_DIR}

${COLOR_BLUE}Quick start${COLOR_RESET} (recommended for new users):

  gs welcome

  The wizard walks you through provider setup, registers your
  first project, runs one verified cycle, and shows you the audit
  log. Setup is about 5 minutes; the first cycle often takes
  10–60+ minutes depending on the model and project. Nothing is
  irreversible until each step's confirmation.

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
