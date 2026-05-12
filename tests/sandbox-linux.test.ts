// Regression tests for the bwrap argv builder. These exercise the
// "project directory could be anywhere" cases that bit us in real-world
// use: workdir inside $HOME (or /tmp, or /run) — all paths that the
// sandbox itself remounts with tmpfs. The fix is that the workdir bind
// must come AFTER any tmpfs that could shadow it.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBwrapArgs } from '../lib/sandbox-linux.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function indexOfTmpfs(argv: readonly string[], target: string): number {
    for (let i = 0; i < argv.length - 1; i++) {
        if (argv[i] === '--tmpfs' && argv[i + 1] === target) return i;
    }
    return -1;
}

function indexOfBind(argv: readonly string[], target: string): number {
    for (let i = 0; i < argv.length - 2; i++) {
        if (argv[i] === '--bind' && argv[i + 2] === target) return i;
    }
    return -1;
}

async function withTempWorkdir<T>(parent: string, fn: (workdir: string) => Promise<T>): Promise<T> {
    await fsp.mkdir(parent, { recursive: true });
    const workdir = await fsp.mkdtemp(path.join(parent, 'ringfence-test-'));
    try {
        return await fn(workdir);
    } finally {
        await fsp.rm(workdir, { recursive: true, force: true });
    }
}

test('workdir bind comes AFTER --tmpfs $HOME (the bug that broke real installs)', async () => {
    const home = process.env.HOME!;
    await withTempWorkdir(home, async (workdir) => {
        const { args } = await buildBwrapArgs({
            pm: 'npm',
            realBin: '/usr/bin/node',
            workdir,
            args: ['install'],
            ringfenceHome: path.join(REPO_ROOT, '.ringfence-doesnt-matter'),
        });

        const tmpfsHomeIdx = indexOfTmpfs(args, home);
        const bindWorkdirIdx = indexOfBind(args, workdir);

        assert.notEqual(tmpfsHomeIdx, -1, '--tmpfs $HOME must be present');
        assert.notEqual(bindWorkdirIdx, -1, '--bind workdir must be present');
        assert.ok(
            bindWorkdirIdx > tmpfsHomeIdx,
            `workdir bind (index ${bindWorkdirIdx}) must come after --tmpfs $HOME (index ${tmpfsHomeIdx})`,
        );
    });
});

test('workdir bind comes AFTER --tmpfs /tmp (for projects living under /tmp)', async () => {
    await withTempWorkdir(os.tmpdir(), async (workdir) => {
        const { args } = await buildBwrapArgs({
            pm: 'npm',
            realBin: '/usr/bin/node',
            workdir,
            args: ['install'],
            ringfenceHome: '/anywhere',
        });

        const tmpfsTmpIdx = indexOfTmpfs(args, '/tmp');
        const bindWorkdirIdx = indexOfBind(args, workdir);

        assert.notEqual(tmpfsTmpIdx, -1, '--tmpfs /tmp must be present');
        // workdir from mkdtemp on most systems is under /tmp; if it isn't
        // (e.g. macOS-like TMPDIR), the assertion below still holds.
        if (workdir.startsWith('/tmp/')) {
            assert.ok(
                bindWorkdirIdx > tmpfsTmpIdx,
                `workdir bind must come after --tmpfs /tmp when workdir is under /tmp`,
            );
        }
    });
});

test('--chdir target matches the workdir bind', async () => {
    const home = process.env.HOME!;
    await withTempWorkdir(home, async (workdir) => {
        const { args } = await buildBwrapArgs({
            pm: 'pnpm',
            realBin: '/usr/bin/node',
            workdir,
            args: ['install'],
            ringfenceHome: '/anywhere',
        });
        const chdirIdx = args.indexOf('--chdir');
        assert.notEqual(chdirIdx, -1, '--chdir must be present');
        assert.equal(args[chdirIdx + 1], workdir, '--chdir target must be the workdir');
    });
});

test('secret files inside workdir get masked with --ro-bind /dev/null', async () => {
    const home = process.env.HOME!;
    await withTempWorkdir(home, async (workdir) => {
        await fsp.writeFile(path.join(workdir, '.env'), 'SECRET=1\n');
        await fsp.writeFile(path.join(workdir, 'prod.pem'), '-----BEGIN-----\n');

        const { args, maskedSecrets } = await buildBwrapArgs({
            pm: 'npm',
            realBin: '/usr/bin/node',
            workdir,
            args: ['install'],
            ringfenceHome: '/anywhere',
        });

        assert.equal(maskedSecrets.length, 2, 'should detect both secrets');

        // Each mask is `--ro-bind /dev/null <secret-path>`.
        for (const secret of maskedSecrets) {
            let found = false;
            for (let i = 0; i < args.length - 2; i++) {
                if (
                    args[i] === '--ro-bind' &&
                    args[i + 1] === '/dev/null' &&
                    args[i + 2] === secret
                ) {
                    found = true;
                    break;
                }
            }
            assert.ok(found, `${secret} should be masked with /dev/null`);
        }
    });
});

test('PATH is rewritten to drop the shim dir inside the sandbox', async () => {
    const home = process.env.HOME!;
    await withTempWorkdir(home, async (workdir) => {
        const ringfenceHome = '/tmp/fake-ringfence';
        const shimDir = path.join(ringfenceHome, 'bin');
        const origPath = process.env.PATH;
        process.env.PATH = `${shimDir}:/usr/bin:/bin`;
        try {
            const { args } = await buildBwrapArgs({
                pm: 'npm',
                realBin: '/usr/bin/node',
                workdir,
                args: ['install'],
                ringfenceHome,
            });
            // last `--setenv PATH <value>` wins
            let pathValue: string | undefined;
            for (let i = 0; i < args.length - 2; i++) {
                if (args[i] === '--setenv' && args[i + 1] === 'PATH') {
                    pathValue = args[i + 2];
                }
            }
            assert.ok(pathValue, 'PATH should be set inside the sandbox');
            assert.ok(!pathValue!.includes(shimDir), 'shim dir must not appear in sandbox PATH');
            assert.ok(pathValue!.includes('/usr/bin'), 'real PATH entries should be preserved');
        } finally {
            process.env.PATH = origPath;
        }
    });
});
