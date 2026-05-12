#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = process.cwd();

const log = (msg) => process.stderr.write(`\x1b[1;34m[ringfence-bootstrap]\x1b[0m ${msg}\n`);

if (process.env.RINGFENCE_ACTIVE === '1') {
    process.exit(0);
}

if (process.env.RINGFENCE_BYPASS === '1') {
    log('RINGFENCE_BYPASS=1 set — letting unsandboxed install proceed.');
    process.exit(0);
}

function detectPM() {
    const ua = process.env.npm_config_user_agent || '';
    if (ua.includes('pnpm')) return 'pnpm';
    if (ua.includes('yarn')) return 'yarn';
    if (ua.includes('bun')) return 'bun';
    const lockFiles = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun']];
    for (const [lock, pm] of lockFiles) {
        if (fs.existsSync(path.join(PROJECT_ROOT, lock))) return pm;
    }
    return 'npm';
}

function findBundle() {
    // 1. Project-local ringfence (handles npm flat, pnpm nested, yarn PnP)
    try {
        const local = require.resolve('ringfence/dist/ringfence.mjs', { paths: [PROJECT_ROOT] });
        if (local && fs.existsSync(local)) return local;
    } catch {}
    // 2. Cached from a previous bootstrap run
    const cached = path.join(PROJECT_ROOT, 'node_modules', '.ringfence', 'dist', 'ringfence.mjs');
    if (fs.existsSync(cached)) return cached;
    // 3. Global ringfence install
    const home = process.env.HOME;
    if (home) {
        const global_ = path.join(home, '.ringfence', 'bin', 'ringfence.mjs');
        if (fs.existsSync(global_)) return global_;
    }
    return null;
}

function originalArgs(pm) {
    if (pm === 'npm' || pm === 'pnpm') {
        try {
            const parsed = JSON.parse(process.env.npm_config_argv || '{}');
            const original = parsed.original;
            if (Array.isArray(original) && original.length > 0) {
                return original.slice(1);
            }
        } catch {}
    }
    return ['install'];
}

(function () {
    const pm = detectPM();
    const bundlePath = findBundle();

    if (!bundlePath) {
        log('ringfence bundle not found. Install ringfence globally (./install.sh) or');
        log('  add it as a dependency: npm i -D ringfence && npx ringfence-init');
        process.exit(2);
    }

    const args = originalArgs(pm);
    log(`detected package manager: ${pm}`);
    log(`re-running "${pm} ${args.join(' ')}" through sandbox...`);

    const result = spawnSync(
        process.execPath,
        [bundlePath, pm, ...args],
        {
            cwd: PROJECT_ROOT,
            stdio: 'inherit',
            env: { ...process.env, RINGFENCE_ACTIVE: '1' },
        },
    );

    if (result.status !== 0) {
        log(`sandboxed install exited with code ${result.status ?? '?'}`);
        process.exit(result.status ?? 1);
    }

    log('install completed successfully under sandbox.');
    log('NOTE: the package manager "preinstall errored" message below is EXPECTED —');
    log('  it stops the outer install from running unsandboxed.');
    log('  Your node_modules is correctly populated.');
    process.exit(1);
})();