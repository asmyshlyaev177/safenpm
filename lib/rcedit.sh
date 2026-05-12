# shellcheck shell=bash
# Shell-rc edit helpers, sourced by install.sh and uninstall.sh.
#
# A "managed line" is a line that ends with a marker comment (e.g. "# ringfence").
# This is the only thing that distinguishes ringfence's PATH entry from any
# other PATH manipulation the user may have in their rc file.
#
# Functions:
#   rcedit_apply  <rc> <desired_line> <marker>
#   rcedit_remove <rc> <marker>
#
# Both print a one-word status (added/updated/unchanged/absent/removed) and
# return 0. Don't `set -e` in scripts that source this file unless you also
# wrap calls with `|| true` — see install.sh.

# Append <line> to <rc>, ensuring exactly one blank line before it. The blank
# line is what rcedit_remove uses to clean up cleanly.
_rcedit_append() {
    local rc="$1" line="$2"
    # Ensure the file ends with a newline before we append.
    if [ -s "$rc" ]; then
        local last
        last="$(tail -c1 -- "$rc")"
        if [ -n "$last" ]; then
            printf '\n' >>"$rc"
        fi
    fi
    printf '\n%s\n' "$line" >>"$rc"
}

rcedit_apply() {
    local rc="$1" desired="$2" marker="$3"

    if [ ! -f "$rc" ]; then
        echo absent
        return 0
    fi

    # Find the first line containing the marker. Use `-n` so we get the
    # line number; use `-F` so the marker can contain `#` etc. without
    # regex surprises. `|| true` keeps us alive when grep finds nothing.
    local match lineno current
    match="$(grep -nF -- "$marker" "$rc" | head -1 || true)"

    if [ -z "$match" ]; then
        _rcedit_append "$rc" "$desired"
        echo added
        return 0
    fi

    lineno="${match%%:*}"
    current="${match#*:}"

    if [ "$current" = "$desired" ]; then
        echo unchanged
        return 0
    fi

    # Replace line <lineno> with <desired> in place.
    local tmp
    tmp="$(mktemp)"
    awk -v ln="$lineno" -v new="$desired" 'NR==ln{print new; next} {print}' "$rc" >"$tmp"
    # Preserve mode/owner where possible by writing into the same fs.
    cat "$tmp" >"$rc"
    rm -f "$tmp"
    echo updated
}

rcedit_remove() {
    local rc="$1" marker="$2"

    if [ ! -f "$rc" ]; then
        echo absent
        return 0
    fi
    if ! grep -Fq -- "$marker" "$rc"; then
        echo absent
        return 0
    fi

    local tmp
    tmp="$(mktemp)"
    # Drop every line containing the marker, plus any blank line that sits
    # directly before a marker line (the one _rcedit_append inserted).
    awk -v marker="$marker" '
        { lines[NR]=$0; mk[NR]=(index($0, marker) > 0) }
        END {
            for (i=1; i<=NR; i++) {
                if (mk[i]) continue
                if (lines[i]=="" && (i+1)<=NR && mk[i+1]) continue
                print lines[i]
            }
        }
    ' "$rc" >"$tmp"
    cat "$tmp" >"$rc"
    rm -f "$tmp"
    echo removed
}
