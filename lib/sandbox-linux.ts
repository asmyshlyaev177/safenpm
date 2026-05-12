import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectSecrets, detectSecretEnvs } from './detect.ts';
import { homeStateDirs, type PackageManager } from './pm.ts';
import * as log from './log.ts';

export type SandboxOpts = {
    pm: PackageManager;
    realBin: string;
    workdir: string;
    args: readonly string[];
    safenpmHome: string;
};

// Compose the bwrap argv. Pure function — no spawning — so it can be unit-tested.
export async function buildBwrapArgs(opts: SandboxOpts): Promise<{
    args: string[];
    maskedSecrets: string[];
    strippedEnvs: string[];
}> {
    const { pm, realBin, workdir, safenpmHome } = opts;
    const home = process.env.HOME;
    if (!home) throw new Error('HOME is not set');

    const args: string[] = [
        '--die-with-parent',
        '--unshare-user-try',
        '--unshare-ipc',
        '--unshare-uts',
        '--unshare-cgroup-try',
        '--share-net',
        '--hostname',
        'safenpm-sandbox',
        '--proc',
        '/proc',
        '--dev',
        '/dev',
        '--tmpfs',
        '/tmp',
        '--tmpfs',
        '/run',
        // core system, read-only
        '--ro-bind',
        '/usr',
        '/usr',
        '--ro-bind-try',
        '/bin',
        '/bin',
        '--ro-bind-try',
        '/sbin',
        '/sbin',
        '--ro-bind-try',
        '/lib',
        '/lib',
        '--ro-bind-try',
        '/lib32',
        '/lib32',
        '--ro-bind-try',
        '/lib64',
        '/lib64',
        '--ro-bind-try',
        '/libx32',
        '/libx32',
        '--ro-bind',
        '/etc',
        '/etc',
        // DNS via systemd-resolved / resolvconf
        '--ro-bind-try',
        '/run/systemd/resolve',
        '/run/systemd/resolve',
        '--ro-bind-try',
        '/run/resolvconf',
        '/run/resolvconf',
        // work directory: read-write, no secrets (they get masked below)
        '--bind',
        workdir,
        workdir,
        '--chdir',
        workdir,
        // Wipe $HOME, then re-expose only what the package manager needs.
        '--tmpfs',
        home,
        '--setenv',
        'HOME',
        home,
    ];

    // The real binary (npm/pnpm/yarn/bun) often lives under $HOME (nvm, fnm,
    // volta). The tmpfs above would hide it, so bind its install prefix
    // (two levels up from the binary captures both bin/ and lib/node_modules
    // or equivalent).
    const prefix = path.dirname(path.dirname(realBin));
    if (fs.existsSync(prefix)) {
        args.push('--ro-bind', prefix, prefix);
    }

    // If the binary is a symlink targeting another prefix, expose that too.
    try {
        const resolved = fs.realpathSync(realBin);
        if (resolved !== realBin) {
            const resolvedPrefix = path.dirname(path.dirname(resolved));
            const sep = path.sep;
            const isInsidePrefix =
                resolvedPrefix === prefix || resolvedPrefix.startsWith(prefix + sep);
            if (!isInsidePrefix && fs.existsSync(resolvedPrefix)) {
                args.push('--ro-bind', resolvedPrefix, resolvedPrefix);
            }
        }
    } catch {
        // realpath can fail on broken symlinks; nothing we can do.
    }

    // Expose pm-specific $HOME state.
    const { ro, rw } = homeStateDirs(pm, home);
    for (const p of ro) {
        if (fs.existsSync(p)) args.push('--ro-bind', p, p);
    }
    for (const p of rw) {
        try {
            fs.mkdirSync(p, { recursive: true });
        } catch {
            // Pre-existing path may have wrong perms; ignore and try to bind.
        }
        if (fs.existsSync(p)) args.push('--bind', p, p);
    }

    // Mask each detected secret with /dev/null (read as a zero-byte file).
    const maskedSecrets: string[] = [];
    const secrets = await detectSecrets(workdir);
    const sep = path.sep;
    for (const s of secrets) {
        if (s !== workdir && !s.startsWith(workdir + sep)) continue;
        args.push('--ro-bind', '/dev/null', s);
        maskedSecrets.push(s);
    }

    // Drop secret-shaped env vars.
    const strippedEnvs = detectSecretEnvs();
    for (const name of strippedEnvs) {
        args.push('--unsetenv', name);
    }

    // Strip our shim dir from PATH inside the sandbox.
    const shimDir = path.join(safenpmHome, 'bin');
    const cleanPath = (process.env.PATH ?? '')
        .split(':')
        .filter((d) => d && d !== shimDir)
        .join(':');
    args.push('--setenv', 'PATH', cleanPath);

    return { args, maskedSecrets, strippedEnvs };
}

export async function runLinux(opts: SandboxOpts): Promise<never> {
    if (!hasBwrap()) {
        log.err("bwrap not installed. Re-run install.sh or install 'bubblewrap'.");
        process.exit(1);
    }

    const { pm, realBin, workdir, args: pmArgs } = opts;
    const { args: bwrapArgs, maskedSecrets, strippedEnvs } = await buildBwrapArgs(opts);

    for (const s of maskedSecrets) {
        log.warn(`masking secret: ${path.relative(workdir, s)}`);
    }
    if (maskedSecrets.length > 0) {
        log.info(`${maskedSecrets.length} secret file(s) hidden from install sandbox`);
    }
    if (strippedEnvs.length > 0) {
        log.info(`${strippedEnvs.length} secret-shaped env var(s) stripped`);
    }

    log.info(`running ${pm} ${pmArgs.join(' ')} in bwrap sandbox`);

    const child = spawn('bwrap', [...bwrapArgs, realBin, ...pmArgs], { stdio: 'inherit' });
    return await new Promise<never>((_resolve, reject) => {
        child.on('error', (e) => reject(e));
        child.on('exit', (code, signal) => {
            process.exit(code ?? (signal ? 128 : 1));
        });
    });
}

function hasBwrap(): boolean {
    const dirs = (process.env.PATH ?? '').split(':');
    return dirs.some((d) => {
        if (!d) return false;
        try {
            fs.accessSync(path.join(d, 'bwrap'), fs.constants.X_OK);
            return true;
        } catch {
            return false;
        }
    });
}
