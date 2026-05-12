// End-to-end test for global installs (npm i -g).
//
// Verifies that the sandbox uses a writable bind mount for the node
// prefix when -g / --global is detected, so binary packages can be
// installed and their CLI entry points work after the sandbox exits.
//
// Test isolation:
//   - A self-contained shim is built in a tempdir per test run.
//   - The bundle at dist/safenpm.mjs must exist (run pnpm build first).
//   - bwrap must be installed (Linux only).

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = path.join(REPO_ROOT, 'dist/safenpm.mjs');
const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;

function hasBwrap(): boolean {
    try {
        execFileSync('bwrap', ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function pmAvailable(pm: string): boolean {
    try {
        execFileSync('which', [pm], { encoding: 'utf8', stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}

function nodePrefix(): string {
    return execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8', stdio: 'pipe' }).trim();
}

const skipReason: string | false =
    process.platform !== 'linux'
        ? 'global install tests require Linux (bwrap)'
        : !hasBwrap()
          ? 'global install tests require bwrap on PATH'
          : !pmAvailable('npm')
            ? 'npm not on PATH'
            : !fs.existsSync(BUNDLE)
              ? `run pnpm build first (missing ${BUNDLE})`
              : false;

const TEST_PKG = 'cowsay';

test(
    `global install: ${TEST_PKG} installs and its binary works`,
    { skip: skipReason },
    async () => {
        const testRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'safenpm-global-'));
        const safenpmHome = path.join(testRoot, 'safenpm');
        const shimDir = path.join(safenpmHome, 'bin');
        const prefix = nodePrefix();

        try {
            // 1. Set up an isolated shim directory (same pattern as security.test.ts).
            await fsp.mkdir(shimDir, { recursive: true });
            await fsp.copyFile(BUNDLE, path.join(shimDir, 'safenpm.mjs'));
            await fsp.chmod(path.join(shimDir, 'safenpm.mjs'), 0o755);
            for (const pm of PACKAGE_MANAGERS) {
                const shim = path.join(shimDir, pm);
                await fsp.writeFile(
                    shim,
                    `#!/usr/bin/env bash\nexec "${shimDir}/safenpm.mjs" ${pm} "$@"\n`,
                );
                await fsp.chmod(shim, 0o755);
            }

            const env = {
                ...process.env,
                SAFENPM_HOME: safenpmHome,
                PATH: `${shimDir}:${process.env.PATH}`,
                // Plant secret env vars to ensure the sandbox doesn't break
                // global installs while still stripping secrets inside.
                AWS_SECRET_ACCESS_KEY: 'AKIA-planted-leak-me',
                NPM_TOKEN: 'npm_planted_leak',
            };

            // 2. Uninstall first to ensure a clean state.
            try {
                execFileSync('npm', ['uninstall', '-g', TEST_PKG], { stdio: 'pipe' });
            } catch {
                // not installed, that's fine
            }

            // 3. Run global install through the safenpm shim.
            execFileSync('npm', ['i', '-g', TEST_PKG], { env, stdio: 'pipe' });

            // 4. Verify the binary symlink exists in the node prefix.
            const binPath = path.join(prefix, 'bin', TEST_PKG);
            const stat = await fsp.stat(binPath);
            assert.ok(
                stat.isFile() || stat.isSymbolicLink(),
                `${binPath} should exist after global install`,
            );

            // 5. Verify the binary actually executes and produces output.
            const output = execFileSync(TEST_PKG, ['--version'], {
                encoding: 'utf8',
                stdio: 'pipe',
            });
            assert.ok(output.trim().length > 0, `${TEST_PKG} --version should produce output`);
        } finally {
            // 6. Clean up: uninstall the test package and remove temp dir.
            try {
                execFileSync('npm', ['uninstall', '-g', TEST_PKG], { stdio: 'pipe' });
            } catch {
                // ignore cleanup errors
            }
            await fsp.rm(testRoot, { recursive: true, force: true });
        }
    },
);
