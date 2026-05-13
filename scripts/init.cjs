#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE = path.resolve(__dirname, 'bootstrap-template.cjs');
const PROJECT_ROOT = process.cwd();
const TARGET_DIR = path.join(PROJECT_ROOT, 'scripts');
const TARGET = path.join(TARGET_DIR, 'ringfence-bootstrap.cjs');
const PKG = path.join(PROJECT_ROOT, 'package.json');
const HOOK_CMD = 'node scripts/ringfence-bootstrap.cjs';

const log = (msg) => process.stdout.write(`[ringfence-init] ${msg}\n`);
const warn = (msg) => process.stderr.write(`[ringfence-init] WARNING: ${msg}\n`);

function detectPM() {
    const locks = [
        ['pnpm-lock.yaml', 'pnpm'],
        ['yarn.lock', 'yarn'],
        ['bun.lockb', 'bun'],
        ['bun.lock', 'bun'],
        ['package-lock.json', 'npm'],
        ['pnpm-lock.yaml', 'pnpm'],
    ];
    for (const [lock, pm] of locks) {
        if (fs.existsSync(path.join(PROJECT_ROOT, lock))) return pm;
    }
    const ua = process.env.npm_config_user_agent || '';
    if (ua.includes('pnpm')) return 'pnpm';
    if (ua.includes('yarn')) return 'yarn';
    if (ua.includes('bun')) return 'bun';
    return 'npm';
}

if (!fs.existsSync(PKG)) {
    process.stderr.write(`[ringfence-init] no package.json found in ${PROJECT_ROOT}\n`);
    process.exit(1);
}

if (!fs.existsSync(TEMPLATE)) {
    process.stderr.write(`[ringfence-init] missing bootstrap template at ${TEMPLATE}\n`);
    process.exit(1);
}

const pm = detectPM();
log(`detected package manager: ${pm}`);

fs.mkdirSync(TARGET_DIR, { recursive: true });

if (fs.existsSync(TARGET)) {
    log(`${path.relative(PROJECT_ROOT, TARGET)} already exists — overwriting with latest template`);
}
fs.copyFileSync(TEMPLATE, TARGET);
fs.chmodSync(TARGET, 0o755);
log(`wrote ${path.relative(PROJECT_ROOT, TARGET)}`);

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
pkg.scripts ??= {};

const existing = pkg.scripts.preinstall;
if (existing && existing !== HOOK_CMD && !existing.includes('ringfence-bootstrap')) {
    warn(`existing preinstall script not modified:`);
    warn(`  ${existing}`);
    warn(`Manually chain it with: "${HOOK_CMD} && ${existing}"`);
} else if (existing === HOOK_CMD) {
    log('preinstall hook already configured');
} else {
    pkg.scripts.preinstall = HOOK_CMD;
    const trailingNewline = fs.readFileSync(PKG, 'utf8').endsWith('\n') ? '\n' : '';
    fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + trailingNewline);
    log('added preinstall hook to package.json');
}

if (!pkg.devDependencies?.ringfence && !pkg.dependencies?.ringfence) {
    warn('ringfence is not listed in {dev,}Dependencies.');
    warn(`Run: ${pm} i -D ringfence`);
}

log('done. Commit scripts/ringfence-bootstrap.cjs and package.json.');