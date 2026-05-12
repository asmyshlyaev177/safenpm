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

print_node_setup_steps() {
    cat >&2 <<'EOF'

To install Node 20 with nvm, run the steps below in order:

  # 1. Install nvm (skip if `command -v nvm` already works)
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash

  # 2. Load nvm into THIS shell (skip if you opened a new terminal)
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

  # 3. Install Node 20 (or newer LTS) and make it your default
  nvm install 20
  nvm alias default 20
  nvm use default

  # 4. Confirm and re-run this installer
  node -v        # should print v20.x.y (or higher)
  ./install.sh

On macOS you can use Homebrew instead of curl for step 1:
  brew install nvm
  mkdir -p "$HOME/.nvm"
  echo 'export NVM_DIR="$HOME/.nvm"'                                       >> ~/.zshrc
  echo '[ -s "/opt/homebrew/opt/nvm/nvm.sh" ] && . "/opt/homebrew/opt/nvm/nvm.sh"' >> ~/.zshrc
  exec $SHELL -l
EOF
}

require_node_20() {
    if ! have node; then
        err "node is required (>= 20) but was not found on PATH."
        print_node_setup_steps
        exit 1
    fi
    local v major
    v="$(node -v 2>/dev/null | sed 's/^v//')"
    major="${v%%.*}"
    if [ -z "$major" ] || [ "$major" -lt 20 ]; then
        err "node $v is too old; safenpm needs >= 20."
        print_node_setup_steps
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
        if have sudo; then
            sudo="sudo"
            log "this step requires root; sudo will prompt for your password"
        else
            err "root access is required to install bwrap, but 'sudo' is not on PATH."
            cat >&2 <<'EOF'

Install bubblewrap manually using your distro's package manager, then re-run
./install.sh:

  Debian / Ubuntu :  apt update && apt install -y bubblewrap
  Fedora / RHEL   :  dnf install -y bubblewrap
  Arch / Manjaro  :  pacman -S --noconfirm bubblewrap
  openSUSE        :  zypper install -y bubblewrap
  Alpine          :  apk add bubblewrap
EOF
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
        err "no supported package manager found on this system."
        cat >&2 <<'EOF'

Install bubblewrap from source or from a third-party repo, then re-run
./install.sh. The package is usually named 'bubblewrap' or 'bwrap'.

  Project home:   https://github.com/containers/bubblewrap
EOF
        exit 1
    fi
}

check_docker_macos() {
    if ! have docker; then
        err "Docker is required on macOS but was not found on PATH."
        cat >&2 <<'EOF'

Install Docker Desktop, then re-run ./install.sh:

  1. Download:  https://docs.docker.com/desktop/install/mac-install/
     (or via Homebrew:  brew install --cask docker)

  2. Launch Docker Desktop from /Applications.

  3. Wait until the whale icon in the menu bar shows "Docker Desktop is running".

  4. Confirm and re-run this installer:
       docker info        # must succeed
       ./install.sh
EOF
        exit 1
    fi
    if ! docker info >/dev/null 2>&1; then
        warn "Docker is installed but the daemon isn't reachable."
        cat >&2 <<'EOF'
[safenpm] Start Docker Desktop now and wait until 'docker info' succeeds.
[safenpm] safenpm will continue installing, but installs will fail until
[safenpm] the Docker daemon is running.
EOF
    fi
}

require_node_20

case "$PLATFORM" in
    linux) install_bwrap_linux ;;
    macos) check_docker_macos ;;
esac

# Locate the dispatcher bundles. The build emits both ESM (.mjs) and CJS
# (.cjs); we ship both so the package can be loaded either way. The shim
# invokes the ESM bundle by default (matches the source style and Node 20+
# ESM startup is on par with CJS).
DIST_MJS="$SRC_DIR/dist/safenpm.mjs"
DIST_CJS="$SRC_DIR/dist/safenpm.cjs"
if [ ! -f "$DIST_MJS" ] || [ ! -f "$DIST_CJS" ]; then
    err "dispatcher bundles not found in $SRC_DIR/dist/"
    cat >&2 <<'EOF'

Build the dispatcher before running install.sh from a repo checkout:

  pnpm install
  pnpm build       # produces dist/safenpm.{mjs,cjs}

If you installed via `npm i -g safenpm` and still hit this, please file
a bug — dist/ should ship in the published tarball.
EOF
    exit 1
fi

log "installing into $SAFENPM_HOME"
mkdir -p "$SHIM_DIR" "$LIB_DIR"
for ext in mjs cjs; do
    install -m 0755 "$SRC_DIR/dist/safenpm.$ext" "$SHIM_DIR/safenpm.$ext"
    if [ -f "$SRC_DIR/dist/safenpm.$ext.map" ]; then
        install -m 0644 "$SRC_DIR/dist/safenpm.$ext.map" "$SHIM_DIR/safenpm.$ext.map"
    fi
done
install -m 0644 "$SRC_DIR/lib/rcedit.sh" "$LIB_DIR/rcedit.sh"
install -m 0755 "$SRC_DIR/uninstall.sh" "$SAFENPM_HOME/uninstall.sh"

# Shims default to ESM; users wanting CJS can set SAFENPM_FORMAT=cjs in
# their shell rc before running an install command.
DISPATCHER_DEFAULT="safenpm.mjs"
for pm in npm pnpm yarn bun; do
    cat >"$SHIM_DIR/$pm" <<EOF
#!/usr/bin/env bash
# safenpm shim for $pm — forwards to the bundled dispatcher.
# Default is ESM; export SAFENPM_FORMAT=cjs to force the CJS bundle.
case "\${SAFENPM_FORMAT:-mjs}" in
    cjs) exec "$SHIM_DIR/safenpm.cjs" $pm "\$@" ;;
    *)   exec "$SHIM_DIR/$DISPATCHER_DEFAULT" $pm "\$@" ;;
esac
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
