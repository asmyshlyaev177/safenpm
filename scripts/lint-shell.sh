#!/usr/bin/env bash
# Lint and format shell scripts with shellcheck + shfmt. Invoked by
# lint-staged on staged .sh files (paths passed as arguments).
#
# Exits non-zero with a helpful message if either tool is missing.
set -euo pipefail

if ! command -v shellcheck >/dev/null 2>&1; then
    echo "[lint-shell] shellcheck is not installed." >&2
    echo "  Install:  dnf install ShellCheck   |  brew install shellcheck   |  apt install shellcheck" >&2
    exit 1
fi
if ! command -v shfmt >/dev/null 2>&1; then
    echo "[lint-shell] shfmt is not installed." >&2
    echo "  Install:  dnf install shfmt        |  brew install shfmt        |  go install mvdan.cc/sh/v3/cmd/shfmt@latest" >&2
    exit 1
fi

if [ "$#" -eq 0 ]; then
    echo "[lint-shell] no files passed" >&2
    exit 0
fi

# Format in place (4-space indent, indent case, binary-next-line).
shfmt -i 4 -ci -bn -w "$@"

# Then lint. -x follows sourced files; -S style raises minor warnings.
shellcheck --severity=style --external-sources "$@"
