// End-to-end test for uninstall.sh.
//
// Verifies that after running the uninstall script:
//   - .zshrc and .bashrc are cleaned of ringfence markers
//   - $RINGFENCE_HOME is deleted
//   - Native package manager binaries (npm, pnpm, yarn, bun) are still
//     accessible and resolve to the real install, not a ringfence shim.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UNINSTALL_SH = path.join(REPO_ROOT, 'uninstall.sh');
const RCEDIT_SH = path.join(REPO_ROOT, 'lib/rcedit.sh');
const BUNDLE = path.join(REPO_ROOT, 'dist/ringfence.mjs');
const FIXTURES = path.join(REPO_ROOT, 'tests/fixtures');

const MARKER = '# ringfence';
const DESIRED_LINE = 'export PATH="$HOME/.ringfence/bin:$PATH"  # ringfence';

const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function makeHome(): Promise<string> {
    return await fsp.mkdtemp(path.join(os.tmpdir(), 'ringfence-uninstall-'));
}

function shq(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
}

function applyEdit(rc: string, desired = DESIRED_LINE, marker = MARKER): string {
    return execFileSync(
        'bash',
        ['-c', `. ${shq(RCEDIT_SH)}; rcedit_apply ${shq(rc)} ${shq(desired)} ${shq(marker)}`],
        { encoding: 'utf8' },
    ).trim();
}

// Source a shell rc file and return the resulting PATH.
function sourceRcAndGetPath(shell: 'bash' | 'zsh', home: string): string {
    const env = {
        ...process.env,
        HOME: home,
        PS1: 'test$ ',
    };
    const r = spawnSync(shell, ['-i', '-c', `echo "PATH=$PATH"`], { env, encoding: 'utf8' });
    if (r.status !== 0) {
        throw new Error(`${shell} exited ${r.status}: ${r.stderr}`);
    }
    const m = r.stdout.match(/^PATH=(.*)$/m);
    if (!m) throw new Error(`no PATH= line in output:\n${r.stdout}`);
    return m[1]!;
}

// Run uninstall.sh with HOME set to `home` and return the status.
function runUninstall(home: string): { status: number; stdout: string; stderr: string } {
    // RINGFENCE_HOME isn't exported by uninstall.sh itself — it defaults to
    // $HOME/.ringfence.  Pass it explicitly so there's no ambiguity.
    const r = spawnSync('bash', [UNINSTALL_SH], {
        env: {
            ...process.env,
            HOME: home,
            RINGFENCE_HOME: path.join(home, '.ringfence'),
        },
        encoding: 'utf8',
    });
    return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function createShimDir(ringfenceHome: string): void {
    const shimDir = path.join(ringfenceHome, 'bin');
    fs.mkdirSync(shimDir, { recursive: true });
    // Copy the ringfence dispatch bundle so the shim has something to
    // reference (creates a realistic $RINGFENCE_HOME layout).
    if (fs.existsSync(BUNDLE)) {
        fs.copyFileSync(BUNDLE, path.join(shimDir, 'ringfence.mjs'));
        fs.chmodSync(path.join(shimDir, 'ringfence.mjs'), 0o755);
    }
    for (const pm of PACKAGE_MANAGERS) {
        const shim = path.join(shimDir, pm);
        fs.writeFileSync(shim, `#!/usr/bin/env bash\nexec "${shimDir}/ringfence.mjs" ${pm} "$@"\n`);
        fs.chmodSync(shim, 0o755);
    }
    // Also copy rcedit.sh so uninstall.sh can find it at $RINGFENCE_HOME/lib/.
    const libDir = path.join(ringfenceHome, 'lib');
    fs.mkdirSync(libDir, { recursive: true });
    fs.copyFileSync(RCEDIT_SH, path.join(libDir, 'rcedit.sh'));
}

const skipZsh = (() => {
    try {
        execFileSync('which', ['zsh'], { stdio: 'ignore' });
        return false;
    } catch {
        return true;
    }
})();

test('uninstall removes ringfence from .zshrc', { skip: skipZsh }, async () => {
    const home = await makeHome();
    try {
        const rc = path.join(home, '.zshrc');
        const original = fs.readFileSync(path.join(FIXTURES, 'omz.zshrc'), 'utf8');
        fs.writeFileSync(rc, original);

        // Simulate install: apply our line to the rc file and create the
        // ringfence home directory.
        assert.equal(applyEdit(rc), 'added');
        createShimDir(path.join(home, '.ringfence'));

        const result = runUninstall(home);
        assert.equal(result.status, 0, `uninstall.sh exited ${result.status}`);

        const after = fs.readFileSync(rc, 'utf8');
        assert.ok(
            !after.includes(MARKER),
            '.zshrc should not contain ringfence marker after uninstall',
        );

        const norm = (s: string) => s.replace(/\n+$/, '\n');
        assert.equal(norm(after), norm(original), '.zshrc should be restored to original content');
    } finally {
        await fsp.rm(home, { recursive: true, force: true });
    }
});

test('uninstall removes ringfence from .bashrc', async () => {
    const home = await makeHome();
    try {
        const rc = path.join(home, '.bashrc');
        const original = fs.readFileSync(path.join(FIXTURES, 'ubuntu.bashrc'), 'utf8');
        fs.writeFileSync(rc, original);

        assert.equal(applyEdit(rc), 'added');
        createShimDir(path.join(home, '.ringfence'));

        const result = runUninstall(home);
        assert.equal(result.status, 0, `uninstall.sh exited ${result.status}`);

        const after = fs.readFileSync(rc, 'utf8');
        assert.ok(
            !after.includes(MARKER),
            '.bashrc should not contain ringfence marker after uninstall',
        );

        const norm = (s: string) => s.replace(/\n+$/, '\n');
        assert.equal(norm(after), norm(original), '.bashrc should be restored to original content');
    } finally {
        await fsp.rm(home, { recursive: true, force: true });
    }
});

test('uninstall removes $RINGFENCE_HOME directory', async () => {
    const home = await makeHome();
    try {
        const ringfenceHome = path.join(home, '.ringfence');
        // Create empty rc so uninstall doesn't fail on missing files,
        // but the important thing is populating $RINGFENCE_HOME.
        fs.writeFileSync(path.join(home, '.bashrc'), '');
        createShimDir(ringfenceHome);

        assert.ok(fs.existsSync(ringfenceHome), 'RINGFENCE_HOME should exist before uninstall');
        assert.ok(
            fs.existsSync(path.join(ringfenceHome, 'bin', 'npm')),
            'shim should exist before uninstall',
        );

        const result = runUninstall(home);
        assert.equal(result.status, 0, `uninstall.sh exited ${result.status}`);

        assert.ok(
            !fs.existsSync(ringfenceHome),
            'RINGFENCE_HOME should be removed after uninstall',
        );
    } finally {
        await fsp.rm(home, { recursive: true, force: true });
    }
});

test('native package manager binaries accessible after uninstall (bash)', async () => {
    const home = await makeHome();
    try {
        const rc = path.join(home, '.bashrc');
        const original = fs.readFileSync(path.join(FIXTURES, 'ubuntu.bashrc'), 'utf8');
        fs.writeFileSync(rc, original);

        // Simulate install: ringfence PATH entry + shim directory.
        assert.equal(applyEdit(rc), 'added');
        const ringfenceHome = path.join(home, '.ringfence');
        createShimDir(ringfenceHome);

        // Before uninstall, sourcing the rc should put ringfence shims first.
        const pathBefore = sourceRcAndGetPath('bash', home);
        const ringfenceBin = path.join(home, '.ringfence', 'bin');
        assert.match(
            pathBefore,
            new RegExp(`(^|:)${escapeRe(ringfenceBin)}(:|$)`),
            'ringfence shim dir should be on PATH before uninstall',
        );

        const result = runUninstall(home);
        assert.equal(result.status, 0, `uninstall.sh exited ${result.status}`);

        // After uninstall, sourcing the rc should NOT have ringfence on PATH.
        const pathAfter = sourceRcAndGetPath('bash', home);
        assert.ok(
            !pathAfter.includes(ringfenceBin),
            'ringfence shim dir should NOT be on PATH after uninstall',
        );

        // All native package managers are still resolvable via the shell
        // (they live on the system PATH, which is inherited from the outer
        // shell — the rc file only adds to it, not replaces it).
        for (const pm of PACKAGE_MANAGERS) {
            const r = spawnSync('bash', ['-i', '-c', `command -v ${pm}`], {
                env: { ...process.env, HOME: home, PS1: 'test$ ' },
                encoding: 'utf8',
            });
            assert.equal(r.status, 0, `\`command -v ${pm}\` should succeed after uninstall`);
            const resolved = r.stdout.trim();
            assert.ok(resolved.length > 0, `resolved path for ${pm} should not be empty`);
            assert.ok(
                !resolved.includes(ringfenceBin),
                `${pm} should resolve to the real binary, not a ringfence shim`,
            );
        }
    } finally {
        await fsp.rm(home, { recursive: true, force: true });
    }
});

test(
    'native package manager binaries accessible after uninstall (zsh)',
    { skip: skipZsh },
    async () => {
        const home = await makeHome();
        try {
            const rc = path.join(home, '.zshrc');
            const original = fs.readFileSync(path.join(FIXTURES, 'omz.zshrc'), 'utf8');
            fs.writeFileSync(rc, original);

            assert.equal(applyEdit(rc), 'added');
            const ringfenceHome = path.join(home, '.ringfence');
            createShimDir(ringfenceHome);

            const pathBefore = sourceRcAndGetPath('zsh', home);
            const ringfenceBin = path.join(home, '.ringfence', 'bin');
            assert.match(
                pathBefore,
                new RegExp(`(^|:)${escapeRe(ringfenceBin)}(:|$)`),
                'ringfence shim dir should be on PATH before uninstall',
            );

            const result = runUninstall(home);
            assert.equal(result.status, 0, `uninstall.sh exited ${result.status}`);

            const pathAfter = sourceRcAndGetPath('zsh', home);
            assert.ok(
                !pathAfter.includes(ringfenceBin),
                'ringfence shim dir should NOT be on PATH after uninstall',
            );

            for (const pm of PACKAGE_MANAGERS) {
                const r = spawnSync('zsh', ['-i', '-c', `command -v ${pm}`], {
                    env: { ...process.env, HOME: home, PS1: 'test$ ' },
                    encoding: 'utf8',
                });
                assert.equal(
                    r.status,
                    0,
                    `\`command -v ${pm}\` should succeed after uninstall in zsh`,
                );
                const resolved = r.stdout.trim();
                assert.ok(resolved.length > 0, `resolved path for ${pm} should not be empty`);
                assert.ok(
                    !resolved.includes(ringfenceBin),
                    `${pm} should resolve to the real binary, not a ringfence shim`,
                );
            }
        } finally {
            await fsp.rm(home, { recursive: true, force: true });
        }
    },
);

test('uninstall handles missing rc files gracefully', async () => {
    const home = await makeHome();
    try {
        // No .zshrc or .bashrc at all — uninstall should not crash.
        const ringfenceHome = path.join(home, '.ringfence');
        createShimDir(ringfenceHome);

        const result = runUninstall(home);
        assert.equal(result.status, 0, `uninstall.sh should exit 0 even with no rc files`);
        assert.ok(!fs.existsSync(ringfenceHome), 'RINGFENCE_HOME should still be removed');
    } finally {
        await fsp.rm(home, { recursive: true, force: true });
    }
});

test('uninstall cleans all three rc files (bashrc, zshrc, profile)', async () => {
    const home = await makeHome();
    try {
        // Write empty rc files with ringfence markers.
        for (const name of ['.bashrc', '.zshrc', '.profile']) {
            fs.writeFileSync(path.join(home, name), `export FOO=bar\n\n${DESIRED_LINE}\n`);
        }
        createShimDir(path.join(home, '.ringfence'));

        const result = runUninstall(home);
        assert.equal(result.status, 0, `uninstall.sh exited ${result.status}`);

        for (const name of ['.bashrc', '.zshrc', '.profile']) {
            const content = fs.readFileSync(path.join(home, name), 'utf8');
            assert.ok(!content.includes(MARKER), `${name} should not contain ringfence marker`);
            assert.ok(!content.includes('.ringfence'), `${name} should not reference ringfence`);
            // The original export FOO=bar should survive.
            assert.ok(
                content.includes('export FOO=bar'),
                `${name} should preserve unrelated content`,
            );
        }
    } finally {
        await fsp.rm(home, { recursive: true, force: true });
    }
});
