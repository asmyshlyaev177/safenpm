#!/usr/bin/env node
// safenpm dispatcher.
//
// Invoked as:  safenpm <pm> <args...>      where pm is npm|pnpm|yarn|bun
//
// Routes install-like subcommands through the platform sandbox (bwrap on
// Linux, Docker on macOS); everything else execs the real package manager
// unchanged.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isInstallLike, isPackageManager } from '../lib/pm.ts';
import { runLinux } from '../lib/sandbox-linux.ts';
import { runMacos } from '../lib/sandbox-macos.ts';
import * as log from '../lib/log.ts';

const SAFENPM_HOME = process.env.SAFENPM_HOME ?? path.join(process.env.HOME ?? '', '.safenpm');
const SHIM_DIR = path.join(SAFENPM_HOME, 'bin');

function findRealBinary(name: string): string | null {
    const selfPath = path.join(SHIM_DIR, name);
    const dirs = (process.env.PATH ?? '').split(':');
    for (const d of dirs) {
        if (!d || d === SHIM_DIR) continue;
        const candidate = path.join(d, name);
        try {
            const st = fs.statSync(candidate);
            if (!st.isFile()) continue;
            // Guard against a symlink that loops back to our shim.
            let resolved = candidate;
            try {
                resolved = fs.realpathSync(candidate);
            } catch {
                // unresolved symlink — still try the candidate path itself
            }
            if (resolved === selfPath) continue;
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

async function main(): Promise<void> {
    const [pmArg, ...args] = process.argv.slice(2);
    if (!pmArg) {
        log.err('missing package manager argument');
        process.exit(2);
    }
    if (!isPackageManager(pmArg)) {
        log.err(`unsupported package manager: ${pmArg}`);
        process.exit(2);
    }

    const realBin = findRealBinary(pmArg);
    if (!realBin) {
        log.err(`real '${pmArg}' not found on PATH (excluding ${SHIM_DIR})`);
        process.exit(127);
    }

    if (!isInstallLike(pmArg, args)) {
        await execPassthrough(realBin, args);
        return; // unreachable; execPassthrough calls process.exit on child exit
    }

    const workdir = process.cwd();
    const sandboxOpts = {
        pm: pmArg,
        realBin,
        workdir,
        args,
        safenpmHome: SAFENPM_HOME,
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
