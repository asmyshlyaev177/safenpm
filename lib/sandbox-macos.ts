import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isSecretFilename, detectSecretEnvs } from './detect.ts';
import { type PackageManager } from './pm.ts';
import * as log from './log.ts';

export type SandboxOpts = {
    pm: PackageManager;
    realBin: string;
    workdir: string;
    args: readonly string[];
    ringfenceHome: string;
};

const NODE_IMAGE = process.env.RINGFENCE_NODE_IMAGE ?? 'node:lts';
const BUN_IMAGE = process.env.RINGFENCE_BUN_IMAGE ?? 'oven/bun:latest';

const PM_AUX_EXCLUDES: ReadonlySet<string> = new Set(['.npmrc', '.yarnrc', '.yarnrc.yml']);

function dockerAvailable(): boolean {
    const dirs = (process.env.PATH ?? '').split(':');
    return dirs.some((d) => {
        if (!d) return false;
        try {
            fs.accessSync(path.join(d, 'docker'), fs.constants.X_OK);
            return true;
        } catch {
            return false;
        }
    });
}

// fs.cp filter: return false to skip a path. Skips secret-named files but
// keeps all directories (we still want to recurse into them).
function makeCopyFilter(rejectAuxConfig: boolean): (src: string) => boolean {
    return (src: string): boolean => {
        const name = path.basename(src);
        if (isSecretFilename(name)) return false;
        if (rejectAuxConfig && PM_AUX_EXCLUDES.has(name)) return false;
        return true;
    };
}

export async function runMacos(opts: SandboxOpts): Promise<never> {
    if (!dockerAvailable()) {
        log.err('docker not installed. Install Docker Desktop for macOS.');
        process.exit(1);
    }

    const { pm, workdir, args: pmArgs } = opts;
    const image = pm === 'bun' ? BUN_IMAGE : NODE_IMAGE;

    const staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'ringfence.'));
    let exitCode: number;

    try {
        log.info(`staging workdir to ${staging} (secrets excluded)`);
        await fsp.cp(workdir, staging, {
            recursive: true,
            filter: makeCopyFilter(false),
            // Preserve mtimes so package managers' caching heuristics work.
            preserveTimestamps: true,
        });

        // Copy host pm config so private-registry auth works inside the container.
        const home = process.env.HOME;
        if (home) {
            for (const name of PM_AUX_EXCLUDES) {
                const src = path.join(home, name);
                if (fs.existsSync(src)) {
                    await fsp.copyFile(src, path.join(staging, name));
                }
            }
        }

        const strippedEnvs = detectSecretEnvs();
        if (strippedEnvs.length > 0) {
            log.info(`${strippedEnvs.length} secret-shaped env var(s) withheld from container`);
        }

        // Pass through all non-secret env vars by name. Docker reads the value
        // from the host process env when only --env NAME is given.
        const skipNames = new Set<string>([
            ...strippedEnvs,
            'HOME',
            'PATH',
            'PWD',
            'USER',
            'LOGNAME',
            'SHLVL',
            '_',
        ]);
        const envArgs: string[] = [];
        for (const name of Object.keys(process.env)) {
            if (skipNames.has(name)) continue;
            envArgs.push('--env', name);
        }

        const containerCmd = composeContainerCmd(pm, pmArgs);

        log.info(`running ${pm} ${pmArgs.join(' ')} in docker (${image})`);
        exitCode = await spawnAndWait('docker', [
            'run',
            '--rm',
            '-i',
            '-v',
            `${staging}:/work`,
            '-w',
            '/work',
            '-e',
            'HOME=/work',
            ...envArgs,
            image,
            'bash',
            '-c',
            containerCmd,
        ]);

        // Sync results back, again rejecting secret-shaped files so a malicious
        // postinstall can't plant fake secrets in the real workdir. No --delete
        // equivalent: files in workdir but not staging (notably the secrets we
        // never copied over) must be preserved.
        log.info(`syncing results back to ${workdir}`);
        await fsp.cp(staging, workdir, {
            recursive: true,
            filter: makeCopyFilter(true),
            force: true,
            preserveTimestamps: true,
        });
    } finally {
        await fsp.rm(staging, { recursive: true, force: true });
    }

    process.exit(exitCode);
}

function composeContainerCmd(pm: PackageManager, args: readonly string[]): string {
    const quoted = args.map(shellQuote).join(' ');
    switch (pm) {
        case 'npm':
            return `npm ${quoted}`;
        case 'pnpm':
            return `corepack enable >/dev/null 2>&1 || true; corepack pnpm ${quoted}`;
        case 'yarn':
            return `corepack enable >/dev/null 2>&1 || true; corepack yarn ${quoted}`;
        case 'bun':
            return `bun ${quoted}`;
    }
}

// Minimal POSIX-shell single-quote escape.
function shellQuote(s: string): string {
    if (/^[A-Za-z0-9_\-./=:@%+,]+$/.test(s)) return s;
    return `'${s.replace(/'/g, `'\\''`)}'`;
}

function spawnAndWait(cmd: string, args: readonly string[]): Promise<number> {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, [...args], { stdio: 'inherit' });
        child.on('error', reject);
        child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
    });
}
