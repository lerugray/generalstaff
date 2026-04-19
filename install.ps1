# GeneralStaff - one-command installer for Windows (PowerShell 5.1+ / 7+).
#
# Usage (from a PowerShell prompt):
#
#   # Fresh install from scratch (clones into .\GeneralStaff\):
#   irm https://raw.githubusercontent.com/lerugray/generalstaff/master/install.ps1 | iex
#
#   # Install into a specific directory:
#   $env:GENERALSTAFF_DIR = "C:\tools\generalstaff"
#   irm https://raw.githubusercontent.com/lerugray/generalstaff/master/install.ps1 | iex
#
#   # Skip bun auto-install if you want to install it yourself:
#   $env:GENERALSTAFF_NO_BUN_INSTALL = "1"
#   irm https://raw.githubusercontent.com/lerugray/generalstaff/master/install.ps1 | iex
#
# What this does, in order:
#   1. Verifies git is on PATH (fails clearly if not; git is not auto-installed)
#   2. Checks for bun; installs it via bun.sh/install.ps1 if missing (opt out)
#   3. Clones the GeneralStaff repo to $env:GENERALSTAFF_DIR (default: .\GeneralStaff)
#      - or, if already cloned there, updates it with 'git pull --ff-only'
#   4. Runs 'bun install' inside the clone
#   5. Prints next steps
#
# What this does NOT do:
#   - No admin elevation. Installs only into directories the user owns.
#   - No PATH modification beyond what bun's own installer does.
#   - No registering projects. That's the user's first real step.
#   - No launching sessions. 'doctor' is the first thing to run post-install.
#
# Safe to re-run. Idempotent: re-runs update the clone, skip bun install
# if already present, re-verify the install layout.

$ErrorActionPreference = "Stop"

# ------------------------------------------------------------
# Configuration (env-overridable)
# ------------------------------------------------------------

$ScriptDir = (Get-Location).Path
if (-not $env:GENERALSTAFF_DIR) {
    $env:GENERALSTAFF_DIR = Join-Path $ScriptDir "GeneralStaff"
}
if (-not $env:GENERALSTAFF_REPO) {
    $env:GENERALSTAFF_REPO = "https://github.com/lerugray/generalstaff.git"
}
if (-not $env:GENERALSTAFF_BRANCH) {
    $env:GENERALSTAFF_BRANCH = "master"
}

# ------------------------------------------------------------
# Pretty output helpers
# ------------------------------------------------------------

function Write-Info    { param($m) Write-Host "[info]  $m" -ForegroundColor Cyan }
function Write-Ok      { param($m) Write-Host "[ ok ]  $m" -ForegroundColor Green }
function Write-Warn    { param($m) Write-Host "[warn]  $m" -ForegroundColor Yellow }
function Write-Fail    { param($m) Write-Host "[fail]  $m" -ForegroundColor Red; exit 1 }
function Write-Section { param($m) Write-Host ""; Write-Host "== $m" -ForegroundColor DarkGray }

# ------------------------------------------------------------
# Step 1 - git check
# ------------------------------------------------------------

Write-Section "Checking prerequisites"

$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) {
    Write-Fail "git is required but not installed. Install Git for Windows from https://git-scm.com/download/win, then re-run this installer."
}
$gitVer = (git --version) 2>$null
Write-Ok "git: $gitVer"

# ------------------------------------------------------------
# Step 2 - bun check / install
# ------------------------------------------------------------

$bunCmd = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bunCmd) {
    if ($env:GENERALSTAFF_NO_BUN_INSTALL) {
        Write-Fail "bun is required but not installed, and GENERALSTAFF_NO_BUN_INSTALL is set. Install bun manually from https://bun.sh, then re-run."
    }
    Write-Info "bun is not installed. Installing via https://bun.sh/install.ps1 (this runs the upstream bun installer, not a GeneralStaff-maintained script)."
    # bun's own installer writes to $env:USERPROFILE\.bun by default.
    # No admin; no system PATH changes beyond what bun does for itself.
    Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression
    $bunExe = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
    if (Test-Path $bunExe) {
        $env:PATH = "$env:USERPROFILE\.bun\bin;$env:PATH"
    }
    $bunCmd = Get-Command bun -ErrorAction SilentlyContinue
    if (-not $bunCmd) {
        Write-Fail "bun installed but is not on PATH. Open a new PowerShell window and re-run this installer, or add %USERPROFILE%\.bun\bin to your PATH manually."
    }
}
$bunVer = (bun --version) 2>$null
Write-Ok "bun: $bunVer"

# ------------------------------------------------------------
# Step 3 - clone or update the repo
# ------------------------------------------------------------

Write-Section "Preparing $env:GENERALSTAFF_DIR"

$gitDir = Join-Path $env:GENERALSTAFF_DIR ".git"
if (Test-Path $gitDir) {
    Write-Info "Existing clone detected; running 'git pull --ff-only' to update."
    git -C $env:GENERALSTAFF_DIR fetch --all --quiet
    git -C $env:GENERALSTAFF_DIR pull --ff-only --quiet
    Write-Ok "Updated existing clone."
}
elseif (Test-Path $env:GENERALSTAFF_DIR) {
    Write-Fail "$env:GENERALSTAFF_DIR exists but is not a git repo. Pick a different GENERALSTAFF_DIR or remove it first."
}
else {
    Write-Info "Cloning $env:GENERALSTAFF_REPO -> $env:GENERALSTAFF_DIR"
    git clone --branch $env:GENERALSTAFF_BRANCH --quiet $env:GENERALSTAFF_REPO $env:GENERALSTAFF_DIR
    Write-Ok "Cloned."
}

Set-Location $env:GENERALSTAFF_DIR

# ------------------------------------------------------------
# Step 4 - bun install
# ------------------------------------------------------------

Write-Section "Installing dependencies"
bun install --silent
if ($LASTEXITCODE -ne 0) { Write-Fail "bun install failed. See output above." }
Write-Ok "Dependencies installed."

# ------------------------------------------------------------
# Step 5 - next steps
# ------------------------------------------------------------

Write-Section "Install complete"

Write-Host ""
Write-Host "GeneralStaff is installed at:" -ForegroundColor Green
Write-Host "  $env:GENERALSTAFF_DIR"
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host ""
Write-Host "  1. Copy the example config and edit it for your first project:"
Write-Host "       cd `"$env:GENERALSTAFF_DIR`""
Write-Host "       Copy-Item projects.yaml.example projects.yaml"
Write-Host "       notepad projects.yaml"
Write-Host ""
Write-Host "  2. Run the doctor to validate your setup:"
Write-Host "       bun src/cli.ts doctor"
Write-Host ""
Write-Host "  3. Register a project (optional - the doctor will suggest this):"
Write-Host "       bun src/cli.ts register --help"
Write-Host ""
Write-Host "  4. Run your first session when you have one project set up:"
Write-Host "       bun src/cli.ts session --budget=30 --dry-run"
Write-Host ""
Write-Host "Docs:"
Write-Host "  README.md       # overview + quickstart"
Write-Host "  CLAUDE.md       # project conventions"
Write-Host "  DESIGN.md       # architecture"
Write-Host "  LAUNCH-PLAN.md  # pre-launch gates"
Write-Host ""
Write-Host "The bot only ever pushes to bot/work on your own git remote."
Write-Host "Your code stays local; your API keys stay local. See Hard Rules in"
Write-Host "CLAUDE.md."
Write-Host ""
