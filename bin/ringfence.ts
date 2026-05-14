#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInstallLike, isPackageManager } from '../lib/pm.ts';
import { runLinux } from '../lib/sandbox-linux.ts';
import { runMacos } from '../lib/sandbox-macos.ts';
import * as log from '../lib/log.ts';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');

const RINGFENCE_HOME =
    process.env.RINGFENCE_HOME ?? path.join(process.env.HOME ?? '', '.ringfence');
const SHIM_DIR = path.join(RINGFENCE_HOME, 'bin');

function findRealBinary(name: string): string | null {
    const selfPath = path.join(SHIM_DIR, name);
    const defaultShimPath = path.join(process.env.HOME ?? '', '.ringfence', 'bin', name);
    const dirs = (process.env.PATH ?? '').split(':');
    for (const d of dirs) {
        if (!d || d === SHIM_DIR) continue;
        const candidate = path.join(d, name);
        try {
            const st = fs.statSync(candidate);
            if (!st.isFile()) continue;
            let resolved = candidate;
            try {
                resolved = fs.realpathSync(candidate);
            } catch {
                // unresolved symlink — still try the candidate path itself
            }
            if (resolved === selfPath || resolved === defaultShimPath) continue;
            fs.accessSync(candidate, fs.constants.X_OK);
            return candidate;
        } catch {
            // not a file, not executable, or stat failed — try next dir
        }
    }
    return null;
}

function execPassthrough(realBin: string, args: readonly string[]): Promise<never> {
    return new Promise<never>((_resolve, reject) => {
        const child = spawn(realBin, [...args], { stdio: 'inherit' });
        child.on('error', (e) => reject(e));
        child.on('exit', (code, signal) => {
            process.exit(code ?? (signal ? 128 : 1));
        });
    });
}

const SETUP_RUNNERS: Record<string, string> = {
    npm: 'npx',
    pnpm: 'pnpm exec',
    yarn: 'yarn',
    bun: 'bunx',
};

function getSetupCommand(): string {
    const pmArg = process.argv[2];
    if (pmArg && SETUP_RUNNERS[pmArg]) return `${SETUP_RUNNERS[pmArg]} ringfence-setup`;
    const ua = process.env.npm_config_user_agent ?? '';
    for (const [prefix, runner] of Object.entries(SETUP_RUNNERS)) {
        if (ua.startsWith(`${prefix}/`)) return `${runner} ringfence-setup`;
    }
    return 'npx ringfence-setup';
}

function ensureSetup(): boolean {
    if (fs.existsSync(SHIM_DIR)) return true;
    const installer = path.join(ROOT, 'install.sh');
    if (!fs.existsSync(installer)) {
        log.warn(`shims not installed. Run:  ${getSetupCommand()}`);
        return false;
    }
    log.info('running first-time setup...');
    const result = spawnSync(installer, [], { stdio: 'inherit', cwd: ROOT });
    if (result.status !== 0) {
        log.warn(`setup failed. Run:  ${getSetupCommand()}`);
    }
    return result.status === 0;
}

async function main(): Promise<void> {
    const [pmArg, ...args] = process.argv.slice(2);

    if (!pmArg) {
        ensureSetup();
        return;
    }

    if (!isPackageManager(pmArg)) {
        log.err(`unsupported package manager: ${pmArg}`);
        log.info('usage: npx ringfence <npm|pnpm|yarn|bun> [args...]');
        process.exit(2);
    }

    ensureSetup();

    const realBin = findRealBinary(pmArg);
    if (!realBin) {
        log.err(`real '${pmArg}' not found on PATH (excluding ${SHIM_DIR})`);
        process.exit(127);
    }

    if (!isInstallLike(pmArg, args)) {
        await execPassthrough(realBin, args);
        return;
    }

    const workdir = process.cwd();
    const sandboxOpts = {
        pm: pmArg,
        realBin,
        workdir,
        args,
        ringfenceHome: RINGFENCE_HOME,
    };

    switch (process.platform) {
        case 'linux':
            if (process.env.RINGFENCE_FORCE_DOCKER) {
                process.exit(await runMacos(sandboxOpts));
            } else {
                await runLinux(sandboxOpts);
            }
            break;
        case 'darwin':
            process.exit(await runMacos(sandboxOpts));
            break;
        default:
            log.err(`unsupported platform: ${process.platform}`);
            process.exit(1);
    }
}

main().catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    log.err(msg);
    process.exit(1);
});
