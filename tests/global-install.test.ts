// End-to-end test for global installs (npm i -g).
//
// Verifies that the sandbox uses a writable bind mount for the node
// prefix when -g / --global is detected, so binary packages can be
// installed and their CLI entry points work after the sandbox exits.
//
// The real shims at ~/.ringfence/bin/ are set up by install.sh in the
// Docker image and are already on PATH.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = path.join(REPO_ROOT, 'dist/ringfence.mjs');

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
        const prefix = nodePrefix();

        try {
            // 1. Uninstall first to ensure a clean state.
            try {
                execFileSync('npm', ['uninstall', '-g', TEST_PKG], { stdio: 'pipe' });
            } catch {
                // not installed, that's fine
            }

            // 2. Run global install through the real ringfence shim on PATH.
            const env = {
                ...process.env,
                // Plant secret env vars to ensure the sandbox doesn't break
                // global installs while still stripping secrets inside.
                AWS_SECRET_ACCESS_KEY: 'AKIA-planted-leak-me',
                NPM_TOKEN: 'npm_planted_leak',
            };
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
            // 6. Clean up: uninstall the test package.
            try {
                execFileSync('npm', ['uninstall', '-g', TEST_PKG], { stdio: 'pipe' });
            } catch {
                // ignore cleanup errors
            }
        }
    },
);

test(
    `global install does not affect package manager for other directories`,
    { skip: skipReason },
    async () => {
        const testRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ringfence-global-'));
        const prefix = nodePrefix();

        try {
            // 1. Uninstall any leftover.
            try {
                execFileSync('npm', ['uninstall', '-g', TEST_PKG], { stdio: 'pipe' });
            } catch {
                // not installed
            }

            // 2. Global install through real shim.
            execFileSync('npm', ['i', '-g', TEST_PKG], { stdio: 'pipe' });

            // 3. Create a separate project directory and run a local install
            //    using the REAL npm (no ringfence shim on PATH).
            const projectDir = path.join(testRoot, 'other-project');
            await fsp.mkdir(projectDir);
            await fsp.writeFile(
                path.join(projectDir, 'package.json'),
                JSON.stringify({
                    name: 'test-after-global',
                    version: '1.0.0',
                    private: true,
                    dependencies: { 'is-number': '^7.0.0' },
                }),
            );

            // Run npm install WITHOUT the ringfence shim in PATH
            // to verify the real npm still works after the global sandboxed install.
            const realPath = (process.env.PATH ?? '')
                .split(':')
                .filter((d) => !d.includes('.ringfence'))
                .join(':');
            execFileSync('npm', ['install', '--package-lock-only'], {
                cwd: projectDir,
                env: { ...process.env, PATH: realPath },
                stdio: 'pipe',
            });

            // 5. Verify the package was resolved (lockfile exists).
            const lockPath = path.join(projectDir, 'package-lock.json');
            const lockStat = await fsp.stat(lockPath);
            assert.ok(lockStat.isFile(), 'package-lock.json should exist after local install');

            // 6. Verify the globally installed binary is still functional.
            const globalBin = path.join(prefix, 'bin', TEST_PKG);
            await fsp.stat(globalBin);
            const output = execFileSync(TEST_PKG, ['--version'], {
                encoding: 'utf8',
                stdio: 'pipe',
            });
            assert.ok(
                output.trim().length > 0,
                `${TEST_PKG} should still work after local install`,
            );
        } finally {
            try {
                execFileSync('npm', ['uninstall', '-g', TEST_PKG], { stdio: 'pipe' });
            } catch {
                // ignore cleanup errors
            }
            await fsp.rm(testRoot, { recursive: true, force: true });
        }
    },
);
