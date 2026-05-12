#!/usr/bin/env bash
# safenpm installer.
#
# Sets up per-user shims that route install commands through a sandbox
# (bwrap on Linux, Docker on macOS). The wrapper logic is TypeScript, run
# directly by Node 24+ via native type stripping.
set -euo pipefail

SAFENPM_HOME="${SAFENPM_HOME:-$HOME/.safenpm}"
SHIM_DIR="$SAFENPM_HOME/bin"
LIB_DIR="$SAFENPM_HOME/lib"

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=lib/rcedit.sh
. "$SRC_DIR/lib/rcedit.sh"

OS="$(uname -s)"
case "$OS" in
    Linux) PLATFORM=linux ;;
    Darwin) PLATFORM=macos ;;
    *)
        echo "safenpm: unsupported OS: $OS (Linux/macOS only)" >&2
        exit 1
        ;;
esac

log() { printf '\033[1;34m[safenpm]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[safenpm]\033[0m %s\n' "$*" >&2; }
err() { printf '\033[1;31m[safenpm]\033[0m %s\n' "$*" >&2; }

have() { command -v "$1" >/dev/null 2>&1; }

require_node_24() {
    if ! have node; then
        err "node is required (>= 24) but was not found on PATH."
        err "Install via nvm (https://github.com/nvm-sh/nvm) and re-run."
        exit 1
    fi
    local v major
    v="$(node -v 2>/dev/null | sed 's/^v//')"
    major="${v%%.*}"
    if [ -z "$major" ] || [ "$major" -lt 24 ]; then
        err "node $v is too old; safenpm needs >= 24 for native TypeScript."
        err "Try:  nvm install 24 && nvm use 24"
        exit 1
    fi
    log "node $v detected"
}

install_bwrap_linux() {
    if have bwrap; then
        log "bwrap already installed: $(bwrap --version 2>&1 | head -1)"
        return 0
    fi
    log "bwrap not found, attempting install via system package manager..."
    local sudo=""
    if [ "$(id -u)" -ne 0 ]; then
        if have sudo; then sudo="sudo"; else
            err "need root or sudo to install bwrap. Install 'bubblewrap' manually and re-run."
            exit 1
        fi
    fi
    if have apt-get; then
        $sudo apt-get update && $sudo apt-get install -y bubblewrap
    elif have dnf; then
        $sudo dnf install -y bubblewrap
    elif have yum; then
        $sudo yum install -y bubblewrap
    elif have pacman; then
        $sudo pacman -S --noconfirm bubblewrap
    elif have zypper; then
        $sudo zypper install -y bubblewrap
    elif have apk; then
        $sudo apk add bubblewrap
    else
        err "no supported package manager found. Install 'bubblewrap' manually."
        exit 1
    fi
}

check_docker_macos() {
    if ! have docker; then
        err "Docker is required on macOS. Install Docker Desktop: https://docs.docker.com/desktop/install/mac-install/"
        exit 1
    fi
    if ! docker info >/dev/null 2>&1; then
        warn "Docker is installed but the daemon isn't reachable. Start Docker Desktop before running installs."
    fi
}

require_node_24

case "$PLATFORM" in
    linux) install_bwrap_linux ;;
    macos) check_docker_macos ;;
esac

log "installing into $SAFENPM_HOME"
mkdir -p "$SHIM_DIR" "$LIB_DIR"
install -m 0755 "$SRC_DIR/bin/safenpm.ts" "$SHIM_DIR/safenpm.ts"
install -m 0644 "$SRC_DIR/lib/pm.ts" "$LIB_DIR/pm.ts"
install -m 0644 "$SRC_DIR/lib/log.ts" "$LIB_DIR/log.ts"
install -m 0644 "$SRC_DIR/lib/detect.ts" "$LIB_DIR/detect.ts"
install -m 0644 "$SRC_DIR/lib/sandbox-linux.ts" "$LIB_DIR/sandbox-linux.ts"
install -m 0644 "$SRC_DIR/lib/sandbox-macos.ts" "$LIB_DIR/sandbox-macos.ts"
install -m 0644 "$SRC_DIR/lib/rcedit.sh" "$LIB_DIR/rcedit.sh"
install -m 0755 "$SRC_DIR/uninstall.sh" "$SAFENPM_HOME/uninstall.sh"

# Tell Node to treat the .ts files as ES modules (otherwise it logs a noisy
# MODULE_TYPELESS_PACKAGE_JSON warning and reparses on every invocation).
cat >"$SAFENPM_HOME/package.json" <<'EOF'
{ "type": "module", "private": true }
EOF

for pm in npm pnpm yarn bun; do
    cat >"$SHIM_DIR/$pm" <<EOF
#!/usr/bin/env bash
# safenpm shim for $pm — forwards to the TS dispatcher.
exec node "$SHIM_DIR/safenpm.ts" $pm "\$@"
EOF
    chmod 0755 "$SHIM_DIR/$pm"
done

# The $HOME / $PATH references are intentionally literal — they expand at
# shell startup time for the user sourcing the rc file, not now.
# shellcheck disable=SC2016
PATH_LINE='export PATH="$HOME/.safenpm/bin:$PATH"  # safenpm'
MARKER='# safenpm'

apply_to_rc() {
    local rc="$1" status
    status="$(rcedit_apply "$rc" "$PATH_LINE" "$MARKER")"
    case "$status" in
        added) log "added PATH line to $rc" ;;
        updated) log "updated PATH line in $rc" ;;
        unchanged) log "$rc already configured" ;;
        absent) : ;; # rc file doesn't exist; that's fine
    esac
}
apply_to_rc "$HOME/.bashrc"
apply_to_rc "$HOME/.zshrc"
apply_to_rc "$HOME/.profile"

log "done. Open a new shell, or run:  export PATH=\"\$HOME/.safenpm/bin:\$PATH\""
log "uninstall with:  $SAFENPM_HOME/uninstall.sh"
