// Tests for the per-project bootstrap installer (scripts/init.cjs).
//
// init.cjs is the `safenpm-init` bin command. In a project directory it:
//   - copies scripts/bootstrap-template.cjs to scripts/safenpm-bootstrap.cjs
//   - adds {"scripts": {"preinstall": "node scripts/safenpm-bootstrap.cjs"}}
//   - warns (but doesn't break) when an existing preinstall hook is present
//   - warns if safenpm isn't in {dev,}Dependencies
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INIT = path.join(REPO_ROOT, 'scripts/init.cjs');
const TEMPLATE = path.join(REPO_ROOT, 'scripts/bootstrap-template.cjs');

type PackageJson = {
    name?: string;
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
};

async function makeProject(pkg: PackageJson): Promise<string> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'safenpm-init-'));
    await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    return dir;
}

function runInit(cwd: string): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync(process.execPath, [INIT], { cwd, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('init copies bootstrap template and adds preinstall hook', async () => {
    const dir = await makeProject({
        name: 'fixture',
        devDependencies: { safenpm: '^0.1.0' },
    });
    try {
        const r = runInit(dir);
        assert.equal(r.status, 0, `init exited ${r.status}: ${r.stderr}`);

        // Stub committed at scripts/safenpm-bootstrap.cjs.
        const stub = path.join(dir, 'scripts/safenpm-bootstrap.cjs');
        assert.ok(fs.existsSync(stub), 'bootstrap stub should exist');
        assert.equal(fs.readFileSync(stub, 'utf8'), fs.readFileSync(TEMPLATE, 'utf8'));

        // Executable bit set.
        const mode = fs.statSync(stub).mode & 0o777;
        assert.equal(mode, 0o755, 'bootstrap stub should be executable');

        // package.json updated.
        const pkg = JSON.parse(
            fs.readFileSync(path.join(dir, 'package.json'), 'utf8'),
        ) as PackageJson;
        assert.equal(pkg.scripts?.preinstall, 'node scripts/safenpm-bootstrap.cjs');
    } finally {
        await fsp.rm(dir, { recursive: true, force: true });
    }
});

test('init is idempotent: second run does not duplicate the hook', async () => {
    const dir = await makeProject({
        name: 'fixture',
        devDependencies: { safenpm: '^0.1.0' },
    });
    try {
        runInit(dir);
        const after1 = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
        runInit(dir);
        const after2 = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
        assert.equal(after1, after2, 'second init must not change package.json');
    } finally {
        await fsp.rm(dir, { recursive: true, force: true });
    }
});

test('init refuses to clobber an unrelated preinstall script', async () => {
    const dir = await makeProject({
        name: 'fixture',
        scripts: { preinstall: 'echo "user-existing-script"' },
        devDependencies: { safenpm: '^0.1.0' },
    });
    try {
        const r = runInit(dir);
        assert.equal(r.status, 0, 'init should still succeed');
        assert.match(r.stderr, /existing preinstall script not modified/);

        const pkg = JSON.parse(
            fs.readFileSync(path.join(dir, 'package.json'), 'utf8'),
        ) as PackageJson;
        assert.equal(
            pkg.scripts?.preinstall,
            'echo "user-existing-script"',
            'existing preinstall must be preserved verbatim',
        );
    } finally {
        await fsp.rm(dir, { recursive: true, force: true });
    }
});

test('init warns when safenpm is not in dependencies', async () => {
    const dir = await makeProject({ name: 'fixture' });
    try {
        const r = runInit(dir);
        assert.equal(r.status, 0);
        assert.match(r.stderr, /safenpm is not listed in/);
    } finally {
        await fsp.rm(dir, { recursive: true, force: true });
    }
});

test('init fails cleanly when package.json is missing', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'safenpm-init-empty-'));
    try {
        const r = runInit(dir);
        assert.notEqual(r.status, 0, 'init must fail in a non-project dir');
        assert.match(r.stderr, /no package\.json found/);
    } finally {
        await fsp.rm(dir, { recursive: true, force: true });
    }
});

test('bootstrap template is a no-op when SAFENPM_ACTIVE=1 (re-entry guard)', () => {
    // We can run the template directly without npm because the SAFENPM_ACTIVE
    // guard is the very first thing it checks. This catches regressions
    // where the guard moves or breaks.
    const r = spawnSync(process.execPath, [TEMPLATE], {
        env: { ...process.env, SAFENPM_ACTIVE: '1' },
        encoding: 'utf8',
    });
    assert.equal(r.status, 0, 'guard must exit success');
    assert.equal(r.stdout, '', 'guard should produce no stdout');
    assert.equal(r.stderr, '', 'guard should produce no stderr');
});

test('bootstrap template bypasses when SAFENPM_BYPASS=1', () => {
    const r = spawnSync(process.execPath, [TEMPLATE], {
        env: { ...process.env, SAFENPM_BYPASS: '1', SAFENPM_ACTIVE: '' },
        encoding: 'utf8',
    });
    assert.equal(r.status, 0, 'bypass must exit success');
    assert.match(r.stderr + r.stdout, /SAFENPM_BYPASS=1/);
});
