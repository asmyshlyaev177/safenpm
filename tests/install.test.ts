// Tests for the shell-rc editing performed by install.sh / uninstall.sh.
//
// These exercise lib/rcedit.sh in isolation, then run the actual shell
// (bash or zsh) against the edited rc and assert that PATH picks up the
// ringfence bin dir. That's stronger than just grepping the file — it
// catches mistakes that produce a syntactically valid but semantically
// wrong line.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RCEDIT_SH = path.join(REPO_ROOT, 'lib/rcedit.sh');
const FIXTURES = path.join(REPO_ROOT, 'tests/fixtures');

const DESIRED = 'export PATH="$HOME/.ringfence/bin:$PATH"  # ringfence';
const MARKER = '# ringfence';

type ApplyStatus = 'added' | 'updated' | 'unchanged' | 'absent';
type RemoveStatus = 'removed' | 'absent';

// Run a shell command and return trimmed stdout.
function sh(cmd: string): string {
    return execFileSync('bash', ['-c', cmd], { encoding: 'utf8' }).trim();
}

// Invoke rcedit_apply against a target rc file. Returns the status word.
function applyEdit(rc: string, desired = DESIRED, marker = MARKER): ApplyStatus {
    return sh(
        `. ${shq(RCEDIT_SH)}; rcedit_apply ${shq(rc)} ${shq(desired)} ${shq(marker)}`,
    ) as ApplyStatus;
}

function removeEdit(rc: string, marker = MARKER): RemoveStatus {
    return sh(`. ${shq(RCEDIT_SH)}; rcedit_remove ${shq(rc)} ${shq(marker)}`) as RemoveStatus;
}

function shq(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Spawn a shell, source the edited rc with $HOME pointed at the test
// tempdir, and return the resulting PATH. Confirms that the rc remains
// valid for the target shell.
function sourceRcAndGetPath(shell: 'bash' | 'zsh', home: string): string {
    const env = {
        ...process.env,
        HOME: home,
        // Force interactive-ish behavior in bash: the Ubuntu fixture returns
        // early when $- doesn't include `i`. We pass `-i` to bash to make it
        // interactive. zsh always sources .zshrc when run interactively too.
        PS1: 'test$ ',
    };
    const args =
        shell === 'bash' ? ['-i', '-c', `echo "PATH=$PATH"`] : ['-i', '-c', `echo "PATH=$PATH"`];
    const r = spawnSync(shell, args, { env, encoding: 'utf8' });
    if (r.status !== 0) {
        throw new Error(`${shell} exited ${r.status}: ${r.stderr}`);
    }
    const m = r.stdout.match(/^PATH=(.*)$/m);
    if (!m) throw new Error(`no PATH= line in output:\n${r.stdout}`);
    return m[1]!;
}

async function makeHome(): Promise<string> {
    return await fsp.mkdtemp(path.join(os.tmpdir(), 'ringfence-test-'));
}

async function cleanup(dir: string): Promise<void> {
    await fsp.rm(dir, { recursive: true, force: true });
}

test('apply on empty .bashrc adds the line', async () => {
    const home = await makeHome();
    try {
        const rc = path.join(home, '.bashrc');
        fs.writeFileSync(rc, '');
        assert.equal(applyEdit(rc), 'added');
        const content = fs.readFileSync(rc, 'utf8');
        assert.ok(content.includes(DESIRED), 'desired line present');
        assert.match(content, new RegExp(`\\n${MARKER}\\s*$|${escapeRe(DESIRED)}\\n?$`));
    } finally {
        await cleanup(home);
    }
});

test('apply on missing rc file is a no-op (absent)', async () => {
    const home = await makeHome();
    try {
        const rc = path.join(home, '.bashrc');
        assert.equal(applyEdit(rc), 'absent');
        assert.ok(!fs.existsSync(rc), 'no rc file created');
    } finally {
        await cleanup(home);
    }
});

test('apply preserves Ubuntu .bashrc content and appends our line', async () => {
    const home = await makeHome();
    try {
        const rc = path.join(home, '.bashrc');
        const original = fs.readFileSync(path.join(FIXTURES, 'ubuntu.bashrc'), 'utf8');
        fs.writeFileSync(rc, original);

        assert.equal(applyEdit(rc), 'added');

        const after = fs.readFileSync(rc, 'utf8');
        // every original line still present
        for (const line of original.split('\n').filter(Boolean)) {
            assert.ok(after.includes(line), `line preserved: ${line}`);
        }
        // our line was appended (not somewhere in the middle)
        assert.ok(after.trimEnd().endsWith(DESIRED), 'our line is at the end');
        // exactly one blank line between the original tail and our line
        assert.match(after, /\n\nexport PATH="\$HOME\/\.ringfence\/bin:\$PATH"\s*# ringfence\n$/);
    } finally {
        await cleanup(home);
    }
});

test('apply is idempotent: second run reports unchanged and file is bit-identical', async () => {
    const home = await makeHome();
    try {
        const rc = path.join(home, '.bashrc');
        fs.writeFileSync(rc, fs.readFileSync(path.join(FIXTURES, 'ubuntu.bashrc'), 'utf8'));

        assert.equal(applyEdit(rc), 'added');
        const after1 = fs.readFileSync(rc);
        assert.equal(applyEdit(rc), 'unchanged');
        const after2 = fs.readFileSync(rc);
        assert.ok(after1.equals(after2), 'rc bytes unchanged on second apply');
    } finally {
        await cleanup(home);
    }
});

test('apply updates an existing marker line in place when desired text changes', async () => {
    const home = await makeHome();
    try {
        const rc = path.join(home, '.zshrc');
        const stale = 'export PATH="$HOME/.ringfence/old-bin:$PATH"  # ringfence';
        fs.writeFileSync(
            rc,
            `# top of file\nalias ll='ls -la'\n\n${stale}\n\nexport EDITOR=nano\n`,
        );

        assert.equal(applyEdit(rc), 'updated');
        const after = fs.readFileSync(rc, 'utf8');

        assert.ok(after.includes(DESIRED), 'new desired line present');
        assert.ok(!after.includes(stale), 'stale line gone');
        assert.match(after, /alias ll='ls -la'/, 'unrelated content preserved');
        assert.match(after, /export EDITOR=nano/, 'trailing content preserved');

        // No duplication: marker appears exactly once.
        const occurrences = after.split('\n').filter((l) => l.includes(MARKER)).length;
        assert.equal(occurrences, 1, 'marker appears exactly once');
    } finally {
        await cleanup(home);
    }
});

test('rcedit_remove strips our line and the blank line we inserted', async () => {
    const home = await makeHome();
    try {
        const rc = path.join(home, '.bashrc');
        const original = fs.readFileSync(path.join(FIXTURES, 'ubuntu.bashrc'), 'utf8');
        fs.writeFileSync(rc, original);

        assert.equal(applyEdit(rc), 'added');
        assert.equal(removeEdit(rc), 'removed');

        const restored = fs.readFileSync(rc, 'utf8');
        // Trailing newline may differ by at most one — normalize.
        const norm = (s: string) => s.replace(/\n+$/, '\n');
        assert.equal(norm(restored), norm(original), 'rc restored to original');
    } finally {
        await cleanup(home);
    }
});

test('rcedit_remove on a file without the marker is a no-op (absent)', async () => {
    const home = await makeHome();
    try {
        const rc = path.join(home, '.bashrc');
        const original = 'export FOO=bar\n';
        fs.writeFileSync(rc, original);
        assert.equal(removeEdit(rc), 'absent');
        assert.equal(fs.readFileSync(rc, 'utf8'), original);
    } finally {
        await cleanup(home);
    }
});

test('bash actually picks up ringfence/bin in $PATH after sourcing the edited .bashrc', async () => {
    const home = await makeHome();
    try {
        const rc = path.join(home, '.bashrc');
        fs.writeFileSync(rc, fs.readFileSync(path.join(FIXTURES, 'ubuntu.bashrc'), 'utf8'));
        applyEdit(rc);

        const newPath = sourceRcAndGetPath('bash', home);
        assert.match(newPath, new RegExp(`(^|:)${escapeRe(home)}/\\.ringfence/bin(:|$)`));
        // and the user's existing ~/.local/bin entry should still be there
        assert.match(newPath, new RegExp(`(^|:)${escapeRe(home)}/\\.local/bin(:|$)`));
    } finally {
        await cleanup(home);
    }
});

test('zsh actually picks up ringfence/bin in $PATH after sourcing the edited .zshrc', async () => {
    const home = await makeHome();
    try {
        const rc = path.join(home, '.zshrc');
        fs.writeFileSync(rc, fs.readFileSync(path.join(FIXTURES, 'omz.zshrc'), 'utf8'));
        applyEdit(rc);

        const newPath = sourceRcAndGetPath('zsh', home);
        assert.match(newPath, new RegExp(`(^|:)${escapeRe(home)}/\\.ringfence/bin(:|$)`));
        // pre-existing PNPM_HOME entry should still be there
        assert.match(newPath, new RegExp(`(^|:)${escapeRe(home)}/\\.local/share/pnpm(:|$)`));
    } finally {
        await cleanup(home);
    }
});

test('install-and-uninstall round-trip restores .bashrc and .zshrc to original bytes', async () => {
    const home = await makeHome();
    try {
        const fixtures: Array<{ rc: string; fixture: string }> = [
            { rc: '.bashrc', fixture: 'ubuntu.bashrc' },
            { rc: '.zshrc', fixture: 'omz.zshrc' },
        ];
        for (const { rc, fixture } of fixtures) {
            const target = path.join(home, rc);
            const original = fs.readFileSync(path.join(FIXTURES, fixture), 'utf8');
            fs.writeFileSync(target, original);

            applyEdit(target);
            removeEdit(target);

            const after = fs.readFileSync(target, 'utf8');
            const norm = (s: string) => s.replace(/\n+$/, '\n');
            assert.equal(
                norm(after),
                norm(original),
                `${rc} should equal original after round-trip`,
            );
        }
    } finally {
        await cleanup(home);
    }
});

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
