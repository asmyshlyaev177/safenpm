// End-to-end test for running install a second time when node_modules
// already exists from a prior sandboxed install.
//
// Verifies that:
//   1. First sandboxed install succeeds (secrets masked, no TTY error)
//   2. Second sandboxed install succeeds (no ENOTEMPTY, no TTY prompt)
//   3. Secrets are still masked on the second run
//   4. Exit code is 0 (not ELIFECYCLE 1 from preinstall-bootstrap)
//
// Test isolation:
//   - A self-contained shim is built in a tempdir per test run.
//   - The bundle at dist/ringfence.mjs must exist (run pnpm build first).
//   - bwrap must be installed (Linux only).

import { describe, test, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = path.join(REPO_ROOT, 'dist/ringfence.mjs');
const PROBE = path.join(REPO_ROOT, 'tests/fixtures/leak-probe-second-install.cjs');

type ProbeResult = { ok: boolean; value?: string; code?: string };
type Results = Record<string, ProbeResult | boolean | string | string[] | null>;

function hasBwrap(): boolean {
    try {
        execFileSync('bwrap', ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

const skipReason: string | false =
    process.platform !== 'linux'
        ? 'second-install tests require Linux (bwrap)'
        : !hasBwrap()
          ? 'second-install tests require bwrap on PATH'
          : !fs.existsSync(BUNDLE)
            ? `run pnpm build first (missing ${BUNDLE})`
            : false;

function setup(): {
    firstResults: string;
    secondResults: string;
    testRoot: string;
} | null {
    if (skipReason) return null;

    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ringfence-2nd-'));
    const workdir = path.join(testRoot, 'project');
    fs.mkdirSync(workdir, { recursive: true });
    const ringfenceHome = path.join(testRoot, 'ringfence');
    const shimDir = path.join(ringfenceHome, 'bin');
    fs.mkdirSync(shimDir, { recursive: true });

    fs.copyFileSync(BUNDLE, path.join(shimDir, 'ringfence.mjs'));
    fs.chmodSync(path.join(shimDir, 'ringfence.mjs'), 0o755);
    for (const pm of ['npm', 'pnpm', 'yarn', 'bun']) {
        const shim = path.join(shimDir, pm);
        fs.writeFileSync(shim, `#!/usr/bin/env bash\nexec "${shimDir}/ringfence.mjs" ${pm} "$@"\n`);
        fs.chmodSync(shim, 0o755);
    }

    fs.writeFileSync(path.join(workdir, '.env'), 'DB_PASSWORD=hunter2\nAPI_KEY=secret\n');
    fs.writeFileSync(path.join(workdir, 'prod.pem'), '-----BEGIN PRIVATE KEY-----\n');
    fs.writeFileSync(path.join(workdir, 'id_ed25519'), 'fake-ssh-key-bytes\n');
    fs.copyFileSync(PROBE, path.join(workdir, 'leak-probe-second.cjs'));
    fs.writeFileSync(
        path.join(workdir, 'package.json'),
        JSON.stringify(
            {
                name: 'ringfence-second-install-fixture',
                version: '0.0.0',
                private: true,
                scripts: { preinstall: 'node leak-probe-second.cjs' },
            },
            null,
            2,
        ),
    );

    function makeEnv(resultsFile: string): Record<string, string> {
        return Object.fromEntries(
            Object.entries({
                ...process.env,
                PATH: `${shimDir}:${process.env.PATH}`,
                RINGFENCE_HOME: ringfenceHome,
                RINGFENCE_RESULTS_FILE: resultsFile,
                AWS_SECRET_ACCESS_KEY: 'AKIA-planted-leak-me',
                NPM_TOKEN: 'npm_planted_leak',
                GITHUB_TOKEN: 'ghp_planted_leak',
                DATABASE_PASSWORD: 'planted-db-leak',
                MY_API_SECRET: 'planted-generic-leak',
                RINGFENCE_TEST_HARMLESS: 'harmless-flag-passes-through',
            }).filter(([_, v]) => v !== undefined),
        );
    }

    const firstResults = path.join(workdir, 'leak-results-first.json');
    const secondResults = path.join(workdir, 'leak-results-second.json');

    execFileSync('npm', ['install'], { cwd: workdir, env: makeEnv(firstResults), stdio: 'pipe' });
    execFileSync('npm', ['install', '--force'], {
        cwd: workdir,
        env: makeEnv(secondResults),
        stdio: 'pipe',
    });

    return { firstResults, secondResults, testRoot };
}

function isLeak(v: unknown): boolean {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    return (v as ProbeResult).ok === true;
}

function readResults(p: string): Results {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Results;
}

const ctx = skipReason ? null : setup();

describe(
    'second-install: install after library is already in place',
    { skip: skipReason, timeout: 60_000 },
    () => {
        after(() => {
            if (ctx) fsp.rm(ctx.testRoot, { recursive: true, force: true }).catch(() => {});
        });

        if (!ctx) return;

        for (const [label, resultsPath] of [
            ['first install', ctx.firstResults] as const,
            ['second install', ctx.secondResults] as const,
        ]) {
            test(`results file exists for ${label}`, () => {
                assert.ok(fs.existsSync(resultsPath), `${label} results missing`);
            });

            test(`secrets masked during ${label}`, () => {
                const r = readResults(resultsPath);
                for (const key of ['project_env', 'project_pem', 'project_sshkey']) {
                    assert.ok(
                        !isLeak(r[key]),
                        `LEAK (${label}): ${key} readable: ${JSON.stringify(r[key])}`,
                    );
                }
            });

            test(`host $HOME blocked during ${label}`, () => {
                const r = readResults(resultsPath);
                for (const key of ['home_bashrc', 'home_zshrc']) {
                    assert.ok(
                        !isLeak(r[key]),
                        `LEAK (${label}): ${key} readable: ${JSON.stringify(r[key])}`,
                    );
                }
            });

            test(`secret env vars stripped during ${label}`, () => {
                const r = readResults(resultsPath);
                for (const key of [
                    'env_aws',
                    'env_npm_token',
                    'env_github_token',
                    'env_db_password',
                    'env_generic_secret',
                ]) {
                    assert.equal(r[key], null, `LEAK (${label}): ${key}=${JSON.stringify(r[key])}`);
                }
            });

            test(`non-secret env passes through during ${label}`, () => {
                const r = readResults(resultsPath);
                assert.equal(r.env_ci_flag, 'harmless-flag-passes-through');
            });

            test(`node_modules exists during ${label} (library in place)`, () => {
                const r = readResults(resultsPath);
                assert.ok(r.node_modules_exists === true, `${label}: node_modules should exist`);
            });
        }
    },
);

// ---------------------------------------------------------------------------
// Non-install commands (build, test, run) must pass through cleanly without
// the bootstrap killing the outer process or requiring RINGFENCE_BYPASS.
// ---------------------------------------------------------------------------

function setupNonInstall(): {
    buildOutput: string;
    testRoot: string;
    shimDir: string;
    workdir: string;
} | null {
    if (skipReason) return null;

    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ringfence-noninst-'));
    const workdir = path.join(testRoot, 'project');
    fs.mkdirSync(workdir, { recursive: true });
    const ringfenceHome = path.join(testRoot, 'ringfence');
    const shimDir = path.join(ringfenceHome, 'bin');
    fs.mkdirSync(shimDir, { recursive: true });

    fs.copyFileSync(BUNDLE, path.join(shimDir, 'ringfence.mjs'));
    fs.chmodSync(path.join(shimDir, 'ringfence.mjs'), 0o755);
    for (const pm of ['npm', 'pnpm', 'yarn', 'bun']) {
        const shim = path.join(shimDir, pm);
        fs.writeFileSync(shim, `#!/usr/bin/env bash\nexec "${shimDir}/ringfence.mjs" ${pm} "$@"\n`);
        fs.chmodSync(shim, 0o755);
    }

    // Plant secrets so the sandbox has work to do even for non-install cmds
    fs.writeFileSync(path.join(workdir, '.env'), 'DB_PASSWORD=hunter2\n');
    fs.writeFileSync(path.join(workdir, 'prod.pem'), '-----BEGIN PRIVATE KEY-----\n');

    const buildOutput = path.join(workdir, 'build-output.txt');
    fs.writeFileSync(
        path.join(workdir, 'package.json'),
        JSON.stringify(
            {
                name: 'ringfence-non-install-fixture',
                version: '0.0.0',
                private: true,
                scripts: {
                    build: `node -e "require('fs').writeFileSync('build-output.txt','built')"`,
                    test: `node -e "process.exit(0)"`,
                },
            },
            null,
            2,
        ),
    );

    function makeEnv(): Record<string, string> {
        return Object.fromEntries(
            Object.entries({
                ...process.env,
                PATH: `${shimDir}:${process.env.PATH}`,
                RINGFENCE_HOME: ringfenceHome,
                AWS_SECRET_ACCESS_KEY: 'AKIA-planted-leak-me',
                CI: 'true',
            }).filter(([_, v]) => v !== undefined),
        );
    }

    const env = makeEnv();

    // First do an install so node_modules and bootstrap are in place
    execFileSync('npm', ['install', '--ignore-scripts'], { cwd: workdir, env, stdio: 'pipe' });

    return { buildOutput, testRoot, shimDir, workdir };
}

const nonInstCtx = setupNonInstall();

describe('non-install commands: build and test pass through cleanly', { skip: skipReason }, () => {
    after(() => {
        if (nonInstCtx)
            fsp.rm(nonInstCtx.testRoot, { recursive: true, force: true }).catch(() => {});
    });

    if (!nonInstCtx) return;

    const envBuilder = () =>
        Object.fromEntries(
            Object.entries({
                ...process.env,
                PATH: `${nonInstCtx.shimDir}:${process.env.PATH}`,
                CI: 'true',
            }).filter(([_, v]) => v !== undefined),
        );

    test('npm run build exits 0 and produces output', () => {
        const env = envBuilder();
        env.RINGFENCE_HOME = path.join(nonInstCtx.testRoot, 'ringfence');
        execFileSync('npm', ['run', 'build'], { cwd: nonInstCtx.workdir, env, stdio: 'pipe' });
        assert.ok(fs.existsSync(nonInstCtx.buildOutput), 'build-output.txt should exist');
        assert.equal(fs.readFileSync(nonInstCtx.buildOutput, 'utf8'), 'built');
    });

    test('npm test exits 0', () => {
        const env = envBuilder();
        env.RINGFENCE_HOME = path.join(nonInstCtx.testRoot, 'ringfence');
        execFileSync('npm', ['test'], { cwd: nonInstCtx.workdir, env, stdio: 'pipe' });
    });

    test('npm run build second time (non-install idempotency)', () => {
        const env = envBuilder();
        env.RINGFENCE_HOME = path.join(nonInstCtx.testRoot, 'ringfence');
        fs.rmSync(nonInstCtx.buildOutput, { force: true });
        execFileSync('npm', ['run', 'build'], { cwd: nonInstCtx.workdir, env, stdio: 'pipe' });
        assert.ok(fs.existsSync(nonInstCtx.buildOutput), 'build-output.txt should exist');
        assert.equal(fs.readFileSync(nonInstCtx.buildOutput, 'utf8'), 'built');
    });

    // Run pnpm through its shim too, to verify cross-PM pass-through
    test('pnpm run build exits 0', () => {
        const env = envBuilder();
        env.RINGFENCE_HOME = path.join(nonInstCtx.testRoot, 'ringfence');
        if (nonInstCtx.workdir)
            fs.rmSync(path.join(nonInstCtx.workdir, 'build-output.txt'), { force: true });
        execFileSync('pnpm', ['run', 'build'], { cwd: nonInstCtx.workdir, env, stdio: 'pipe' });
        assert.ok(fs.existsSync(nonInstCtx.buildOutput), 'build-output.txt should exist');
        assert.equal(fs.readFileSync(nonInstCtx.buildOutput, 'utf8'), 'built');
    });

    test('npm exec (non-install) exits 0', () => {
        const env = envBuilder();
        env.RINGFENCE_HOME = path.join(nonInstCtx.testRoot, 'ringfence');
        execFileSync('npm', ['exec', '--', 'node', '-e', 'process.exit(0)'], {
            cwd: nonInstCtx.workdir,
            env,
            stdio: 'pipe',
        });
    });
});
