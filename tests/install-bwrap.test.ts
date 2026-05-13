// Tests for the bwrap system package installation logic in install.sh.
//
// These exercise install_bwrap_linux() by sourcing install.sh in subprocesses
// with controlled PATH, HOME, and environment, then asserting on stdout,
// stderr, exit codes, and mock executable call logs.
//
// All tests run inside the Docker test container where bubblewrap is
// pre-installed. Tests that need bwrap "missing" hide it by scoping PATH
// to a temp directory with only the mock executables we provide.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_SH = path.join(REPO_ROOT, 'install.sh');

function shq(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function makeTmp(): Promise<string> {
    return await fsp.mkdtemp(path.join(os.tmpdir(), 'ringfence-install-bwrap-'));
}

// Symlink essential system binaries into mock dir so install.sh runs with
// a controlled PATH (no system bwrap leaking in).
const SYSTEM_BINS = [
    'dirname',
    'uname',
    'sed',
    'id',
    'grep',
    'head',
    'tail',
    'awk',
    'cat',
    'mktemp',
    'rm',
    'mkdir',
    'chmod',
    'printf',
];
async function symlinkSystemBins(binDir: string): Promise<void> {
    for (const tool of SYSTEM_BINS) {
        const p = `/usr/bin/${tool}`;
        const dest = path.join(binDir, tool);
        if (fs.existsSync(p)) {
            await fsp.symlink(p, dest);
        }
    }
    // /bin symlinks
    for (const tool of ['install']) {
        const p = `/usr/bin/${tool}`;
        const dest = path.join(binDir, tool);
        if (fs.existsSync(p)) {
            await fsp.symlink(p, dest);
        }
    }
}

// Write a mock executable that records its invocation to a log file.
async function writeMock(binDir: string, name: string, logFile: string): Promise<void> {
    await fsp.writeFile(
        path.join(binDir, name),
        `#!/bin/bash
echo "name=${name} args=$*" >> ${shq(logFile)}
exit 0
`,
        { mode: 0o755 },
    );
}

// Read all lines from a mock log file.
function readMockLog(logFile: string): string[] {
    try {
        const content = fs.readFileSync(logFile, 'utf8').trim();
        return content ? content.split('\n') : [];
    } catch {
        return [];
    }
}

// Run install.sh in a subprocess with controlled environment.
// Returns stdout, stderr, and exit status regardless of exit code.
function runInstallSubprocess(params: {
    binDir: string;
    homeDir: string;
    ringfenceHome: string;
    isRoot: boolean;
}): { stdout: string; stderr: string; status: number } {
    const { binDir, homeDir, ringfenceHome, isRoot } = params;

    // Write a minimal .bashrc so rcedit_apply has something to work with.
    fs.writeFileSync(path.join(homeDir, '.bashrc'), '# test rc\n');

    const script = [
        `export HOME=${shq(homeDir)}`,
        `export RINGFENCE_HOME=${shq(ringfenceHome)}`,
        `export PATH=${shq(binDir)}`,
        'export NO_COLOR=1',
        `cd ${shq(binDir)}`,
        `source ${shq(INSTALL_SH)}`,
    ].join('; ');

    const shell = isRoot ? 'bash' : 'su';
    const args = isRoot
        ? ['-c', script]
        : ['-s', '/bin/bash', 'nobody', '-c', `exec bash -c ${shq(script)}`];

    const r = spawnSync(shell, args, { encoding: 'utf8', timeout: 30_000 });

    return {
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? '',
        status: r.status ?? 1,
    };
}

// Helper to set up a minimal test environment with symlinked system bins
// and a mock node.
async function setupTestEnv(tmp: string): Promise<{
    binDir: string;
    homeDir: string;
    ringfenceHome: string;
}> {
    const binDir = path.join(tmp, 'bin');
    const homeDir = path.join(tmp, 'home');
    const ringfenceHome = path.join(tmp, 'ringfence');
    await fsp.mkdir(binDir, { recursive: true });
    await fsp.mkdir(homeDir, { recursive: true });
    await fsp.mkdir(ringfenceHome, { recursive: true });

    // Symlink system bins needed by install.sh so it can run with
    // PATH limited to binDir only (keeps system bwrap out).
    await symlinkSystemBins(binDir);

    // Mock node so require_node_20 passes.
    await fsp.writeFile(
        path.join(binDir, 'node'),
        `#!/bin/bash
if [ "$1" = "-v" ]; then echo "v22.0.0"; exit 0; fi
exec /usr/bin/node "$@"
`,
        { mode: 0o755 },
    );

    return { binDir, homeDir, ringfenceHome };
}

const ROOT = process.getuid?.() === 0;

// ---------------------------------------------------------------------------
// bwrap already installed
// ---------------------------------------------------------------------------
test('install_bwrap_linux: bwrap already on PATH skips installation', async () => {
    const tmp = await makeTmp();
    try {
        const { binDir, homeDir, ringfenceHome } = await setupTestEnv(tmp);

        // Mock bwrap that just prints version.
        await fsp.writeFile(
            path.join(binDir, 'bwrap'),
            `#!/bin/bash
echo "bwrap version 0.8.0"
exit 0
`,
            { mode: 0o755 },
        );

        const logFile = path.join(tmp, 'mock.log');
        await writeMock(binDir, 'apt-get', logFile);

        const result = runInstallSubprocess({ binDir, homeDir, ringfenceHome, isRoot: true });
        assert.equal(result.status, 0, 'should exit 0');
        assert.match(result.stdout, /bwrap already installed/);
        assert.equal(readMockLog(logFile).length, 0, 'package manager should not be invoked');
    } finally {
        await fsp.rm(tmp, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Root + each supported package manager
// ---------------------------------------------------------------------------
const PACKAGE_MANAGERS: Array<{
    binary: string;
    name: string;
    assertCalls(log: string[]): void;
}> = [
    {
        binary: 'apt-get',
        name: 'apt-get',
        assertCalls(log) {
            assert.ok(
                log.some((c) => c.includes('args=update')),
                'apt-get update called',
            );
            assert.ok(
                log.some((c) => c.includes('args=install -y bubblewrap')),
                'apt-get install -y bubblewrap called',
            );
        },
    },
    {
        binary: 'dnf',
        name: 'dnf',
        assertCalls(log) {
            assert.ok(log.some((c) => c.includes('install -y bubblewrap')));
        },
    },
    {
        binary: 'yum',
        name: 'yum',
        assertCalls(log) {
            assert.ok(log.some((c) => c.includes('install -y bubblewrap')));
        },
    },
    {
        binary: 'pacman',
        name: 'pacman',
        assertCalls(log) {
            assert.ok(log.some((c) => c.includes('-S --noconfirm bubblewrap')));
        },
    },
    {
        binary: 'zypper',
        name: 'zypper',
        assertCalls(log) {
            assert.ok(log.some((c) => c.includes('install -y bubblewrap')));
        },
    },
    {
        binary: 'apk',
        name: 'apk',
        assertCalls(log) {
            assert.ok(log.some((c) => c.includes('add bubblewrap')));
        },
    },
];

for (const pm of PACKAGE_MANAGERS) {
    test(`install_bwrap_linux: root + ${pm.name} → runs correct install command`, async () => {
        const tmp = await makeTmp();
        try {
            const { binDir, homeDir, ringfenceHome } = await setupTestEnv(tmp);

            const logFile = path.join(tmp, 'mock.log');
            await writeMock(binDir, pm.binary, logFile);

            const result = runInstallSubprocess({ binDir, homeDir, ringfenceHome, isRoot: true });
            const calls = readMockLog(logFile);

            assert.equal(result.status, 0, `${pm.name} should exit 0`);
            assert.ok(calls.length > 0, `${pm.name} should have been invoked`);
            pm.assertCalls(calls);
        } finally {
            await fsp.rm(tmp, { recursive: true, force: true });
        }
    });
}

// ---------------------------------------------------------------------------
// Missing package manager (root)
// ---------------------------------------------------------------------------
test('install_bwrap_linux: root + no supported package manager → errors with exit 1', async () => {
    const tmp = await makeTmp();
    try {
        const { binDir, homeDir, ringfenceHome } = await setupTestEnv(tmp);

        // Only node on PATH — no package manager binaries at all.
        const result = runInstallSubprocess({ binDir, homeDir, ringfenceHome, isRoot: true });

        assert.notEqual(result.status, 0, 'should exit non-zero');
        assert.match(result.stderr + result.stdout, /no supported package manager found/i);
        assert.match(result.stderr + result.stdout, /bubblewrap/i);
    } finally {
        await fsp.rm(tmp, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Non-root without sudo
// ---------------------------------------------------------------------------
test('install_bwrap_linux: non-root + no sudo → errors with exit 1', { skip: !ROOT }, async () => {
    const tmp = await makeTmp();
    try {
        const { binDir, homeDir, ringfenceHome } = await setupTestEnv(tmp);

        // Make tmp accessible to nobody user.
        await fsp.chmod(tmp, 0o777);
        await fsp.chmod(binDir, 0o777);
        await fsp.chmod(homeDir, 0o777);
        await fsp.chmod(ringfenceHome, 0o777);

        // Only node on PATH — no sudo, no package managers.
        const result = runInstallSubprocess({ binDir, homeDir, ringfenceHome, isRoot: false });

        assert.notEqual(result.status, 0, 'should exit non-zero');
        const output = result.stderr + result.stdout;
        assert.match(output, /root access is required/i);
        assert.match(output, /sudo.*not on PATH/i);
    } finally {
        await fsp.rm(tmp, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Non-root with sudo
// ---------------------------------------------------------------------------
test(
    'install_bwrap_linux: non-root + sudo + apt-get → uses sudo prefix',
    { skip: !ROOT },
    async () => {
        const tmp = await makeTmp();
        try {
            const { binDir, homeDir, ringfenceHome } = await setupTestEnv(tmp);

            // Make tmp accessible to nobody user.
            await fsp.chmod(tmp, 0o777);
            await fsp.chmod(binDir, 0o777);
            await fsp.chmod(homeDir, 0o777);
            await fsp.chmod(ringfenceHome, 0o777);

            const logFile = path.join(tmp, 'mock.log');

            // Mock sudo that logs the call then proxies to the real command.
            await fsp.writeFile(
                path.join(binDir, 'sudo'),
                `#!/bin/bash
echo "name=sudo args=$*" >> ${shq(logFile)}
exec "$@"
`,
                { mode: 0o755 },
            );
            await writeMock(binDir, 'apt-get', logFile);

            const result = runInstallSubprocess({ binDir, homeDir, ringfenceHome, isRoot: false });

            const calls = readMockLog(logFile);
            assert.equal(result.status, 0, 'should exit 0');
            assert.ok(calls.length > 0, 'binaries should have been invoked');

            const sudoCalls = calls.filter((c) => c.startsWith('name=sudo'));
            assert.ok(sudoCalls.length > 0, 'sudo should be invoked');
            assert.ok(
                sudoCalls.some((c) => c.includes('apt-get')),
                'sudo should run apt-get',
            );
        } finally {
            await fsp.rm(tmp, { recursive: true, force: true });
        }
    },
);

// ---------------------------------------------------------------------------
// require_node_20
// ---------------------------------------------------------------------------
test('require_node_20: passes when node >= 20 is on PATH', async () => {
    const tmp = await makeTmp();
    try {
        const { binDir, homeDir, ringfenceHome } = await setupTestEnv(tmp);

        // bwrap on PATH so install_bwrap_linux passes too.
        await fsp.writeFile(
            path.join(binDir, 'bwrap'),
            `#!/bin/bash
echo "bwrap version 0.8.0"
exit 0
`,
            { mode: 0o755 },
        );

        const result = runInstallSubprocess({ binDir, homeDir, ringfenceHome, isRoot: true });
        assert.equal(result.status, 0, 'should exit 0');
        assert.match(result.stdout, /node 22\.0\.0 detected/);
    } finally {
        await fsp.rm(tmp, { recursive: true, force: true });
    }
});

test('require_node_20: fails when node version is too old', async () => {
    const tmp = await makeTmp();
    try {
        const { binDir, homeDir, ringfenceHome } = await setupTestEnv(tmp);

        // Override the node mock with an older version.
        await fsp.writeFile(
            path.join(binDir, 'node'),
            `#!/bin/bash
if [ "$1" = "-v" ]; then echo "v18.19.0"; exit 0; fi
exec /usr/bin/node "$@"
`,
            { mode: 0o755 },
        );
        // bwrap on PATH so install_bwrap_linux won't interfere.
        await fsp.writeFile(
            path.join(binDir, 'bwrap'),
            `#!/bin/bash
echo "bwrap version 0.8.0"
exit 0
`,
            { mode: 0o755 },
        );

        const result = runInstallSubprocess({ binDir, homeDir, ringfenceHome, isRoot: true });
        assert.notEqual(result.status, 0, 'should exit non-zero');
        assert.match(result.stderr + result.stdout, /too old/i);
    } finally {
        await fsp.rm(tmp, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Full install.sh flow
// ---------------------------------------------------------------------------
test('install.sh on Linux calls install_bwrap_linux via case dispatch', async () => {
    const tmp = await makeTmp();
    try {
        const { binDir, homeDir, ringfenceHome } = await setupTestEnv(tmp);

        // bwrap already present.
        await fsp.writeFile(
            path.join(binDir, 'bwrap'),
            `#!/bin/bash
echo "bwrap version 0.8.0"
exit 0
`,
            { mode: 0o755 },
        );

        const result = runInstallSubprocess({ binDir, homeDir, ringfenceHome, isRoot: true });
        assert.equal(result.status, 0, 'install.sh should exit 0');
        assert.match(result.stdout, /bwrap already installed/);
        assert.match(result.stdout, /installing into/);
    } finally {
        await fsp.rm(tmp, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Linux platform detection
// ---------------------------------------------------------------------------
test('install.sh detects Linux platform via uname', async () => {
    const tmp = await makeTmp();
    try {
        const { binDir, homeDir, ringfenceHome } = await setupTestEnv(tmp);

        // bwrap on PATH so the full script proceeds.
        await fsp.writeFile(
            path.join(binDir, 'bwrap'),
            `#!/bin/bash
echo "bwrap version 0.8.0"
exit 0
`,
            { mode: 0o755 },
        );

        // Source install.sh then inspect $PLATFORM.
        const script = [
            `export HOME=${shq(homeDir)}`,
            `export RINGFENCE_HOME=${shq(ringfenceHome)}`,
            `export PATH=${shq(binDir)}`,
            'export NO_COLOR=1',
            `cd ${shq(binDir)}`,
            `source ${shq(INSTALL_SH)} 2>&1 || true`,
            'echo "PLATFORM_CHECK=$PLATFORM"',
        ].join('; ');

        const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 30_000 });
        assert.equal(r.status ?? 1, 0, 'bash should exit 0');
        assert.match(r.stdout ?? '', /PLATFORM_CHECK=linux/);
    } finally {
        await fsp.rm(tmp, { recursive: true, force: true });
    }
});
