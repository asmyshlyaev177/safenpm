# safenpm

Transparent sandbox around `npm install` (and `pnpm`, `yarn`, `bun`) so a
malicious postinstall script can't read your `.env`, SSH keys, or cloud
credentials.

- **Linux**: uses [bubblewrap](https://github.com/containers/bubblewrap) to
  hide each detected secret file, replace `$HOME` with a tmpfs, and unset
  secret-shaped environment variables.
- **macOS**: same effect via an ephemeral Docker container with a
  secret-filtered copy of the project mounted.

Network is left unrestricted so registries, `git:` deps, and tarball URLs
keep working.

## Requirements

- **Node.js 24+** (uses native TypeScript type stripping — no build step).
- **Linux**: `bubblewrap` (installed automatically by `install.sh`).
- **macOS**: Docker Desktop running.

A `.nvmrc` is included pinning Node 24.

## Install

```sh
./install.sh
```

The installer:

- verifies Node ≥ 24,
- installs `bubblewrap` via your system package manager (Linux) or checks
  that Docker is running (macOS),
- creates `~/.safenpm/{bin,lib}` and copies the `.ts` sources there,
- drops bash shims for `npm`, `pnpm`, `yarn`, `bun` into `~/.safenpm/bin`
  (they `exec node ~/.safenpm/bin/safenpm.ts …`),
- prepends that directory to `PATH` in `~/.bashrc`, `~/.zshrc`, `~/.profile`.

Open a new shell, then use `npm` / `pnpm` / `yarn` / `bun` as you normally
would. No new command to learn.

## What's sandboxed

Only install-like subcommands — the ones that fetch and execute third-party
code with lifecycle scripts:

- `npm`: `install`, `i`, `ci`, `add`, `update`, `rebuild`, `exec`
- `pnpm`: `install`, `add`, `update`, `rebuild`, `dlx`, `create`
- `yarn`: `install` (default), `add`, `upgrade`, `create`, `dlx`
- `bun`: `install`, `add`, `update`, `create`, `x`

Everything else (`npm run dev`, `npm test`, etc.) passes through unchanged.

## What's hidden

Files inside the project that match secret-looking patterns:

```text
.env, .env.*, .envrc, .netrc, .pgpass, .my.cnf
credentials, secrets, *secret*.json/yaml/yml
*.pem, *.key, *.crt, *.cer, *.pfx, *.p12, *.jks, *.keystore
id_rsa*, id_dsa*, id_ecdsa*, id_ed25519*
known_hosts, authorized_keys
*.gpg, *.asc
gcloud-*.json, service-account*.json
```

Environment variables whose names match `*TOKEN*`, `*SECRET*`, `*PASSWORD*`,
`*API_KEY*`, `*PRIVATE_KEY*`, `*CREDENTIAL*`, or known cloud-provider
prefixes (`AWS_`, `GITHUB_`, `NPM_`, ...) are unset before the package
manager runs.

`~/.npmrc`, `~/.yarnrc`, `~/.yarnrc.yml` are mounted read-only so auth
tokens for private registries still work. Everything else in `$HOME`
(`~/.ssh`, `~/.aws`, `~/.gnupg`, ...) is invisible.

## Project layout

```text
bin/safenpm.ts         dispatcher (Node entry point)
lib/pm.ts              package-manager metadata + install-like detection
lib/detect.ts          secret-file and secret-env enumeration
lib/sandbox-linux.ts   builds bwrap argv and execs
lib/sandbox-macos.ts   stages workdir, runs Docker container, syncs back
lib/log.ts             colored stderr helpers
install.sh             one-shot bash installer
uninstall.sh
```

All wrapper logic is TypeScript, run directly by Node — no build step, no
emitted artifacts.

## Contributing

System prereqs (used by the pre-commit hook):

- **ShellCheck** — `dnf install ShellCheck` / `brew install shellcheck` / `apt install shellcheck`
- **shfmt** — `dnf install shfmt` / `brew install shfmt`

Then:

```sh
pnpm install        # installs deps and activates the husky pre-commit hook
pnpm test           # node:test suite (10 cases covering rc-file editing)
pnpm typecheck      # tsc --noEmit
pnpm check          # eslint (read-only): fails if anything needs fixing
pnpm fix            # eslint --fix: lint and format every supported file type
```

ESLint is the single entry point for both lint and format. `@eslint/json`
and `@eslint/markdown` give it support for `.json` and `.md`;
`eslint-plugin-prettier` plugs Prettier in as the formatter, so a single
`pnpm fix` formats `.ts`, `.js`, `.json`, and `.md` consistently.

Shell scripts go through `shfmt` + `ShellCheck` separately (pre-commit
hook only — ESLint has no shell support).

The pre-commit hook runs `lint-staged` (eslint on .ts/.js/.json/.md,
ShellCheck + shfmt on .sh) followed by `tsc --noEmit`.

Stick to "erasable" TypeScript (no `enum`, `namespace`, parameter
properties) so Node's native type stripping keeps working without
`--experimental-transform-types`.

## Uninstall

```sh
~/.safenpm/uninstall.sh
```

## Limitations

- bwrap masks secrets with `/dev/null`, leaving zero-byte files where the
  real ones were. Code that _expects_ a missing file (rather than empty)
  may behave oddly during install.
- The macOS path syncs results back without deletion semantics, so packages
  uninstalled during the run linger in `node_modules` until you clear it.
- Heuristic detection only — files named neither like a secret nor matching
  the patterns above are not hidden.
- ~80–150 ms of Node startup overhead per `npm`/`pnpm`/`yarn`/`bun`
  invocation, including pass-through ones. If this becomes a problem, the
  shim can be split: bash fast-path for non-install commands, Node for
  install.
