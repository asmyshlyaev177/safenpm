# ringfence

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

- **Node.js ≥ 20** (the dispatcher is shipped as a pre-built CJS bundle).
- **Linux**: `bubblewrap` (installed automatically by `install.sh`).
- **macOS**: Docker Desktop running.

## Install — Linux

### 1. Install nvm (skip if you already have it)

```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
```

Then open a new shell, or:

```sh
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
```

### 2. Install Node 20 (or newer) and make it the default

```sh
nvm install 20
nvm alias default 20
nvm use default
node -v          # should print v20.x.y or higher
```

### 3a. Install from npm (recommended)

```sh
npm i -g ringfence
ringfence-setup     # runs the installer (bwrap + shims + rc edit)
```

### 3b. Or install from a repo clone

```sh
git clone https://github.com/<your-fork>/ringfence.git
cd ringfence
pnpm install
pnpm build        # produces dist/ringfence.cjs
./install.sh
```

The installer:

1. verifies Node ≥ 24,
2. installs `bubblewrap` via your system package manager (`apt`, `dnf`,
   `pacman`, `zypper`, or `apk`) — uses `sudo` and prompts if needed,
3. creates `~/.ringfence/{bin,lib}` and copies the `.ts` sources there,
4. drops bash shims for `npm`, `pnpm`, `yarn`, `bun` into `~/.ringfence/bin`,
5. prepends that directory to `PATH` in `~/.bashrc`, `~/.zshrc`, `~/.profile`.

### 4. Activate the shim in your current shell

```sh
exec $SHELL -l    # or simply open a new terminal
which npm         # should print /home/<you>/.ringfence/bin/npm
```

### 5. Verify it works

```sh
mkdir /tmp/ringfence-check && cd /tmp/ringfence-check
echo 'SECRET=hunter2' > .env
echo '{"name":"t","version":"1.0.0"}' > package.json
npm install       # should print [ringfence] masking secret: .env
cat .env          # still readable on the host — sandbox only hid it from npm
```

## Install — macOS

### 1. Install Homebrew (skip if you have it)

```sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### 2. Install nvm + Node 20

```sh
brew install nvm
mkdir -p "$HOME/.nvm"
# Add nvm to your shell rc (one-time):
echo 'export NVM_DIR="$HOME/.nvm"'                                       >> ~/.zshrc
echo '[ -s "/opt/homebrew/opt/nvm/nvm.sh" ] && \. "/opt/homebrew/opt/nvm/nvm.sh"' >> ~/.zshrc
exec $SHELL -l

nvm install 20
nvm alias default 20
nvm use default
```

### 3. Install Docker Desktop and start it

Download from <https://docs.docker.com/desktop/install/mac-install/>, install,
launch it, and wait until the whale icon shows "running" in the menu bar.

```sh
docker info     # must succeed before running ringfence installs
```

### 4. Install ringfence

```sh
npm i -g ringfence
ringfence-setup
exec $SHELL -l
```

The setup skips the bubblewrap step on macOS and verifies Docker is
reachable instead. The rest is identical to Linux.

## Using ringfence

After install, just use `npm`, `pnpm`, `yarn`, or `bun` as you normally
would — no new command to learn. Install-like subcommands route through the
sandbox; everything else (`npm run`, `npm test`, `npx`, ...) passes through
unchanged.

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
bin/ringfence.ts         dispatcher entry point
lib/pm.ts              package-manager metadata + install-like detection
lib/detect.ts          secret-file and secret-env enumeration
lib/sandbox-linux.ts   builds bwrap argv and execs
lib/sandbox-macos.ts   stages workdir, runs Docker container, syncs back
lib/log.ts             colored stderr helpers
lib/rcedit.sh          shell-rc edit helpers (sourced by install/uninstall)
scripts/build.mjs      esbuild bundler config
install.sh             one-shot bash installer (npm bin: ringfence-setup)
uninstall.sh
dist/ringfence.cjs       bundled dispatcher (generated, gitignored, shipped)
```

The wrapper is written in TypeScript and bundled to a single self-contained
CJS file via esbuild — this keeps the runtime requirement at Node ≥ 20
while letting contributors work in modern TS.

## Contributing

System prereqs (used by the pre-commit hook):

- **ShellCheck** — `dnf install ShellCheck` / `brew install shellcheck` / `apt install shellcheck`
- **shfmt** — `dnf install shfmt` / `brew install shfmt`

Then:

```sh
pnpm install        # installs deps and activates the husky pre-commit hook
pnpm build          # bundle bin/ringfence.ts → dist/ringfence.cjs via esbuild
pnpm test           # node:test suite (10 cases covering rc-file editing)
pnpm typecheck      # tsc --noEmit
pnpm check          # eslint (read-only): fails if anything needs fixing
pnpm fix            # eslint --fix: lint and format every supported file type
```

Contributors need Node ≥ 22.6 (for the test suite, which uses native TS
type-stripping in `node --test`). End users only need Node ≥ 20 because
the shipped dispatcher is the pre-built CJS bundle.

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
~/.ringfence/uninstall.sh
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
