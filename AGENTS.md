# AI Agent Instructions

## Running tests

**NEVER run tests directly on the host machine.** Tests modify host files under `$HOME` and plant secrets on the filesystem. Every test must run inside Docker — no exceptions.

### Linux sandbox tests (bwrap)

```
pnpm run test:docker
```

### macOS sandbox tests (Docker-in-Docker)

```
pnpm run test:macos
```

### Lint & typecheck (safe, no Docker needed)

```
pnpm run typecheck
pnpm run check
```
