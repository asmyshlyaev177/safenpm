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

function ensureSetup(): boolean {
    if (fs.existsSync(SHIM_DIR)) return true;
    const installer = path.join(ROOT, 'install.sh');
    if (!fs.existsSync(installer)) return false;
    log.info('running first-time setup...');
    const result = spawnSync(installer, [], { stdio: 'inherit', cwd: ROOT });
    return result.status === 0;
}

function ensureInit(): boolean {
    const pkgPath = path.join(process.cwd(), 'package.json');
    if (!fs.existsSync(pkgPath)) return false;
    const target = path.join(process.cwd(), 'scripts', 'ringfence-bootstrap.cjs');
    if (fs.existsSync(target)) return true;
    const initScript = path.join(ROOT, 'scripts', 'init.cjs');
    if (!fs.existsSync(initScript)) return false;
    log.info('initializing project bootstrap...');
    const result = spawnSync(process.execPath, [initScript], {
        stdio: 'inherit',
        cwd: process.cwd(),
    });
    return result.status === 0;
}

async function main(): Promise<void> {
    const [pmArg, ...args] = process.argv.slice(2);

    if (!pmArg || pmArg === '--init') {
        ensureSetup();
        ensureInit();
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
            await runLinux(sandboxOpts);
            break;
        case 'darwin':
            await runMacos(sandboxOpts);
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
