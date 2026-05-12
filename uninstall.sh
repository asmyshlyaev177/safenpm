#!/usr/bin/env bash
set -euo pipefail
SAFENPM_HOME="${SAFENPM_HOME:-$HOME/.safenpm}"

# Locate rcedit.sh: prefer the one installed alongside this script (when
# invoked via $SAFENPM_HOME/uninstall.sh after install), fall back to the
# source checkout (when invoked directly from the repo).
THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for candidate in "$THIS_DIR/lib/rcedit.sh" "$SAFENPM_HOME/lib/rcedit.sh"; do
    if [ -f "$candidate" ]; then
        # shellcheck source=lib/rcedit.sh
        . "$candidate"
        break
    fi
done

MARKER='# safenpm'

if ! declare -F rcedit_remove >/dev/null; then
    # Fallback: minimal inline removal so uninstall still works if the
    # library is missing (e.g. partial install).
    rcedit_remove() {
        local rc="$1" marker="$2"
        [ -f "$rc" ] || {
            echo absent
            return 0
        }
        grep -Fq -- "$marker" "$rc" || {
            echo absent
            return 0
        }
        local tmp
        tmp="$(mktemp)"
        grep -Fv -- "$marker" "$rc" >"$tmp"
        cat "$tmp" >"$rc"
        rm -f "$tmp"
        echo removed
    }
fi

remove_from_rc() {
    local rc="$1" status
    status="$(rcedit_remove "$rc" "$MARKER")"
    case "$status" in
        removed) echo "[safenpm] cleaned $rc" ;;
        absent) : ;;
    esac
}
remove_from_rc "$HOME/.bashrc"
remove_from_rc "$HOME/.zshrc"
remove_from_rc "$HOME/.profile"

if [ -d "$SAFENPM_HOME" ]; then
    rm -rf "$SAFENPM_HOME"
    echo "[safenpm] removed $SAFENPM_HOME"
fi
echo "[safenpm] uninstalled. Open a new shell to refresh PATH."
