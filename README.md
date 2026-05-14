# ringfence — supply-chain security for npm/pnpm/yarn/bun install

<div align="center">

[![npm](https://img.shields.io/npm/v/ringfence.svg)](https://www.npmjs.com/package/ringfence)
![Tests](https://github.com/asmyshlyaev177/ringfence/actions/workflows/test.yml/badge.svg?branch=main)

</div>

Every time you run `npm install`, you hand your secrets to hundreds of
third-party postinstall scripts. Supply-chain worms (dubbed "Shai-Hulud"
after the sandworm that swallows everything in its path) use these hooks
to exfiltrate `.env` files, SSH keys, and cloud credentials from your
machine. **ringfence** wraps install commands in a lightweight sandbox so
a compromised dependency can't touch your secrets or `$HOME`.

Works transparently — keep using your normal commands, no config needed.

- **Linux**: uses [bubblewrap](https://github.com/containers/bubblewrap) to
  mask each detected secret file with `/dev/null`, replace `$HOME` with a
  tmpfs, and unset secret-shaped environment variables.
- **macOS**: achieves the same isolation through an ephemeral Docker
  container with a secret-filtered copy of the project mounted.

Network stays unrestricted — registries, `git:` deps, and tarball URLs
work as usual.

## Quick start

```sh
npm i -D ringfence
npx ringfence
```

Two commands, same on npm, pnpm, yarn, and bun. Adds ringfence as a dev
dependency, then auto-detects your OS, installs `bubblewrap` (Linux) or
validates Docker (macOS), and sets up a `preinstall` hook so every future
`npm install` in this project runs sandboxed.

<details>
<summary>macOS prerequisites</summary>

Ringfence on macOS needs <a href="https://docs.docker.com/desktop/install/mac-install/">Docker Desktop</a>
to run containers. Make sure <code>docker info</code> succeeds before running <code>npx ringfence</code>.

</details>

### Verify it works

```sh
mkdir /tmp/ringfence-check && cd /tmp/ringfence-check
echo 'SECRET=hunter2' > .env
echo '{"name":"t","version":"1.0.0"}' > package.json
npm init -y
npm i -D ringfence && npx ringfence
npm install       # should print [ringfence] masking secret: .env
cat .env          # still readable on the host — sandbox only hid it from npm
```

Two commands, same on npm, pnpm, yarn, and bun. Adds ringfence as a dev
dependency, then auto-detects your OS, installs `bubblewrap` (Linux) or
validates Docker (macOS), and sets up a `preinstall` hook so every future
`npm install` in this project runs sandboxed.

<details>
<summary>macOS prerequisites</summary>

Ringfence on macOS needs <a href="https://docs.docker.com/desktop/install/mac-install/">Docker Desktop</a>
to run containers. Make sure <code>docker info</code> succeeds before running <code>npx ringfence</code>.

</details>

### Verify it works

```sh
mkdir /tmp/ringfence-check && cd /tmp/ringfence-check
echo 'SECRET=hunter2' > .env
echo '{"name":"t","version":"1.0.0"}' > package.json
npm init -y
npm i -D ringfence && npx ringfence
npm install       # should print [ringfence] masking secret: .env
cat .env          # still readable on the host — sandbox only hid it from npm
```

## How it works

Ringfence adds a `preinstall` hook to your project that intercepts install
commands and routes them through the sandbox. Non-install commands (`npm run`,
`npm test`, `npx`, etc.) pass through unchanged.

The first `npm install` after adding ringfence triggers setup: it detects
your OS, installs `bubblewrap` (Linux) or validates Docker (macOS), and
generates a bootstrap script under `scripts/`. Every subsequent install
runs inside the sandbox automatically.

**What's sandboxed:**

| Manager | Intercepted subcommands                                  |
| ------- | -------------------------------------------------------- |
| `npm`   | `install`, `i`, `ci`, `add`, `update`, `rebuild`, `exec` |
| `pnpm`  | `install`, `add`, `update`, `rebuild`, `dlx`, `create`   |
| `yarn`  | `install` (default), `add`, `upgrade`, `create`, `dlx`   |
| `bun`   | `install`, `add`, `update`, `create`, `x`                |

**What's hidden:**

Files matching secret patterns — `.env`, `.env.*`, `.netrc`, `*.pem`,
`id_rsa*`, `*.gpg`, `credentials.json`, `secret*.{json,yaml,yml}`,
`*.key`, cloud service account files, and more — are masked with
`/dev/null` inside the sandbox.

Environment variables matching `*TOKEN*`, `*SECRET*`, `*PASSWORD*`,
`*API_KEY*`, `*PRIVATE_KEY*`, `*CREDENTIAL*`, or known cloud prefixes
(`AWS_`, `GITHUB_`, `NPM_`, ...) are unset before the package manager runs.

`~/.npmrc`, `~/.yarnrc`, `~/.yarnrc.yml` are mounted read-only so private
registry auth still works. Everything else in `$HOME` (`~/.ssh`, `~/.aws`,
`~/.gnupg`, ...) is invisible.

## Uninstall

```sh
npx ringfence-uninstall
# or if you still have ringfence on PATH:
~/.ringfence/uninstall.sh
```

Removes the PATH entry from `~/.bashrc`, `~/.zshrc`, `~/.profile` and
deletes `~/.ringfence`. Open a new shell afterward. Package managers
continue working normally.

## Limitations

- bwrap masks secrets with `/dev/null` (zero-byte files). Code that
  expects a missing file rather than an empty one may behave oddly
  during install.
- macOS syncs results without deletion semantics — packages removed
  during the run stay in `node_modules` until you clear them.
- ~80–150 ms of Node startup overhead per invocation, including
  pass-through commands.

## Requirements

- **Node.js ≥ 20**
- **Linux**: `bubblewrap` (installed automatically)
- **macOS**: Docker Desktop

## Contributing

```sh
pnpm install        # installs deps + activates pre-commit hook
pnpm build          # bundle → dist/
pnpm test           # node:test suite (runs inside Docker)
pnpm typecheck      # tsc --noEmit
pnpm check          # eslint (read-only)
pnpm fix            # eslint --fix
```

Contributors need Node ≥ 22.6 (for native TS type stripping in the test
suite). System prereqs: `ShellCheck` + `shfmt` (used by pre-commit hook).
