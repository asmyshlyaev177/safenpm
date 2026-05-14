import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installer = resolve(root, 'install.sh');
const dist = resolve(root, 'dist', 'ringfence.mjs');

if (!existsSync(dist)) {
    process.exit(0);
}

function detectPM() {
    const ua = process.env.npm_config_user_agent || '';
    if (ua.startsWith('pnpm/')) return 'pnpm';
    if (ua.startsWith('yarn/')) return 'yarn';
    if (ua.startsWith('bun/')) return 'bun';
    return 'npm';
}

const setupRunners = { npm: 'npx', pnpm: 'pnpm exec', yarn: 'yarn', bun: 'bunx' };

try {
    execSync(`bash "${installer}"`, { stdio: 'inherit', cwd: root });
} catch {
    const r = setupRunners[detectPM()];
    console.log(`\x1b[1;33m[ringfence]\x1b[0m Setup was skipped or failed.`);
    console.log(`\x1b[1;33m[ringfence]\x1b[0m Run:  ${r} ringfence-setup`);
}
