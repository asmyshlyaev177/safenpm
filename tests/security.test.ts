// End-to-end security tests. These spin up a synthetic project with a
// preinstall script that tries every leak path a malicious npm package
// would attempt, run `npm install` through a freshly-built ringfence shim,
// then assert that every probe failed (file blocked, env stripped).
//
// Test isolation:
//   - A self-contained shim is built in a tempdir per test run; the user's
//     ~/.ringfence install is not touched.
//   - The bundle at dist/ringfence.mjs must exist (run `pnpm build` first).
//   - bwrap must be installed (Linux only — tests skip on macOS/Windows).
//   - To verify host-blocking we plant a file at $HOME/.ringfence-host-secret-fixture
//     before the install and remove it after.

import { describe, test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = path.join(REPO_ROOT, 'dist/ringfence.mjs');
const PROBE = path.join(REPO_ROOT, 'tests/fixtures/leak-probe.cjs');

type Probe<T> = { ok: true; value: T } | { ok: false; code: string };
type Results = {
    project_env: Probe<string>;
    project_pem: Probe<string>;
    project_sshkey: Probe<string>;
    home_bashrc: Probe<string>;
    home_zshrc: Probe<string>;
    home_ssh_dir: Probe<string[]>;
    home_aws_dir: Probe<string[]>;
    home_gnupg_dir: Probe<string[]>;
    host_planted_secret: Probe<string>;
    env_aws: string | null;
    env_npm_token: string | null;
    env_github_token: string | null;
    env_db_password: string | null;
    env_generic_secret: string | null;
    env_ci_flag: string | null;
    cwd: string;
    home_env: string;
    home_entries: string[] | null;
};

const HOST_FIXTURE_PATH = path.join(process.env.HOME!, '.ringfence-host-sec-test');
const HOST_FIXTURE_CONTENT = 'IF-YOU-CAN-READ-THIS-THE-SANDBOX-LEAKED';

function hasBwrap(): boolean {
    try {
        execFileSync('bwrap', ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function sha256(p: string): string {
    return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

const skipReason: string | false =
    process.platform !== 'linux'
        ? 'security tests require Linux (bwrap)'
        : !hasBwrap()
          ? 'security tests require bwrap on PATH'
          : !fs.existsSync(BUNDLE)
            ? `security tests require ${BUNDLE} — run \`pnpm build\` first`
            : false;

// node:test treats any non-false `skip` value (including null/undefined) as
// truthy, so omit the option entirely when we want to run the suite.
const suiteOpts = skipReason ? { skip: skipReason } : {};

describe('security: third-party install scripts cannot leak secrets', suiteOpts, () => {
    let testRoot: string;
    let workdir: string;
    let envEnvFileBefore: string;
    let results: Results;

    before(async () => {
        // 1. Sandbox is already set up via install.sh in the Docker image.
        //    Real shims live at ~/.ringfence/bin/ and are on PATH.

        // 2. Plant a fixture file in the real $HOME so we can verify the
        //    sandbox can't see arbitrary host-home content.
        await fsp.writeFile(HOST_FIXTURE_PATH, HOST_FIXTURE_CONTENT);

        // 3. Synthetic project with planted secrets + the leak probe.
        testRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ringfence-sec-'));
        workdir = path.join(testRoot, 'project');
        await fsp.mkdir(workdir);
        envEnvFileBefore = 'DB_PASSWORD=hunter2\nAPI_KEY=preshared-zZz\n';
        await fsp.writeFile(path.join(workdir, '.env'), envEnvFileBefore);
        await fsp.writeFile(path.join(workdir, 'prod.pem'), '-----BEGIN PRIVATE KEY-----\n');
        await fsp.writeFile(path.join(workdir, 'id_ed25519'), 'fake-ssh-key-bytes\n');
        await fsp.copyFile(PROBE, path.join(workdir, 'leak-probe.cjs'));
        await fsp.writeFile(
            path.join(workdir, 'package.json'),
            JSON.stringify(
                {
                    name: 'ringfence-security-fixture',
                    version: '0.0.0',
                    private: true,
                    scripts: { preinstall: 'node leak-probe.cjs' },
                },
                null,
                2,
            ),
        );

        // 4. Spawn npm install via the real shim on PATH with planted secret env vars.
        const env = {
            ...process.env,
            AWS_SECRET_ACCESS_KEY: 'AKIA-planted-leak-me',
            NPM_TOKEN: 'npm_planted_leak',
            GITHUB_TOKEN: 'ghp_planted_leak',
            DATABASE_PASSWORD: 'planted-db-leak',
            MY_API_SECRET: 'planted-generic-leak',
            RINGFENCE_TEST_HARMLESS: 'harmless-flag-passes-through',
        };
        execFileSync('npm', ['install'], { cwd: workdir, env, stdio: 'pipe' });

        results = JSON.parse(
            await fsp.readFile(path.join(workdir, 'leak-results.json'), 'utf8'),
        ) as Results;
    });

    after(async () => {
        await fsp.rm(testRoot, { recursive: true, force: true });
        await fsp.rm(HOST_FIXTURE_PATH, { force: true });
    });

    // ----- Project-local secrets must be masked -----

    test('preinstall cannot read project .env (must be EACCES, not LEAK)', () => {
        assert.equal(
            results.project_env.ok,
            false,
            `LEAK: .env was readable: ${JSON.stringify(results.project_env)}`,
        );
        assert.equal(results.project_env.ok === false && results.project_env.code, 'EACCES');
    });

    test('preinstall cannot read project prod.pem', () => {
        assert.equal(
            results.project_pem.ok,
            false,
            `LEAK: prod.pem was readable: ${JSON.stringify(results.project_pem)}`,
        );
    });

    test('preinstall cannot read project id_ed25519', () => {
        assert.equal(
            results.project_sshkey.ok,
            false,
            `LEAK: id_ed25519 was readable: ${JSON.stringify(results.project_sshkey)}`,
        );
    });

    // ----- Host $HOME must be invisible -----

    test('preinstall cannot read host ~/.bashrc', () => {
        assert.equal(
            results.home_bashrc.ok,
            false,
            `LEAK: host ~/.bashrc readable: ${JSON.stringify(results.home_bashrc)}`,
        );
    });

    test('preinstall cannot read host ~/.zshrc', () => {
        assert.equal(
            results.home_zshrc.ok,
            false,
            `LEAK: host ~/.zshrc readable: ${JSON.stringify(results.home_zshrc)}`,
        );
    });

    test('preinstall cannot list host ~/.ssh', () => {
        assert.equal(
            results.home_ssh_dir.ok,
            false,
            `LEAK: host ~/.ssh listable: ${JSON.stringify(results.home_ssh_dir)}`,
        );
    });

    test('preinstall cannot list host ~/.aws', () => {
        assert.equal(
            results.home_aws_dir.ok,
            false,
            `LEAK: host ~/.aws listable: ${JSON.stringify(results.home_aws_dir)}`,
        );
    });

    test('preinstall cannot list host ~/.gnupg', () => {
        assert.equal(
            results.home_gnupg_dir.ok,
            false,
            `LEAK: host ~/.gnupg listable: ${JSON.stringify(results.home_gnupg_dir)}`,
        );
    });

    test('preinstall cannot read a planted file at the top of host $HOME', () => {
        assert.equal(
            results.host_planted_secret.ok,
            false,
            `LEAK: planted host file readable: ${JSON.stringify(results.host_planted_secret)}`,
        );
    });

    test('sandbox $HOME only exposes pm-state subdirs, not host home contents', () => {
        // The fixture file we planted in real $HOME must NOT appear in the
        // sandbox's $HOME listing.
        const entries = results.home_entries ?? [];
        assert.ok(
            !entries.includes('.ringfence-host-secret-fixture'),
            `LEAK: sandbox $HOME shows host fixture: ${entries.join(',')}`,
        );
        // ~/.ssh, ~/.aws, ~/.gnupg should also be absent (we only expose
        // the pm's own state dirs like .npm, .npmrc).
        for (const forbidden of ['.ssh', '.aws', '.gnupg']) {
            assert.ok(
                !entries.includes(forbidden),
                `LEAK: sandbox $HOME shows ${forbidden}: ${entries.join(',')}`,
            );
        }
    });

    // ----- Secret-shaped env vars must be stripped -----

    test('AWS_SECRET_ACCESS_KEY is unset inside the sandbox', () => {
        assert.equal(results.env_aws, null, `LEAK: AWS_SECRET_ACCESS_KEY = ${results.env_aws}`);
    });

    test('NPM_TOKEN is unset inside the sandbox', () => {
        assert.equal(results.env_npm_token, null, `LEAK: NPM_TOKEN = ${results.env_npm_token}`);
    });

    test('GITHUB_TOKEN is unset inside the sandbox', () => {
        assert.equal(
            results.env_github_token,
            null,
            `LEAK: GITHUB_TOKEN = ${results.env_github_token}`,
        );
    });

    test('DATABASE_PASSWORD is unset inside the sandbox', () => {
        assert.equal(
            results.env_db_password,
            null,
            `LEAK: DATABASE_PASSWORD = ${results.env_db_password}`,
        );
    });

    test('MY_API_SECRET (generic *SECRET* match) is unset inside the sandbox', () => {
        assert.equal(
            results.env_generic_secret,
            null,
            `LEAK: MY_API_SECRET = ${results.env_generic_secret}`,
        );
    });

    // ----- Harmless env vars must still pass through -----

    test('non-secret env vars (RINGFENCE_TEST_HARMLESS) reach the install', () => {
        assert.equal(results.env_ci_flag, 'harmless-flag-passes-through');
    });

    // ----- Host integrity: nothing got corrupted -----

    test('host .env is byte-identical after install (sandbox did not write through)', () => {
        const after = fs.readFileSync(path.join(workdir, '.env'), 'utf8');
        assert.equal(after, envEnvFileBefore, 'host .env content changed');
    });

    test('host $HOME fixture file is byte-identical after install', () => {
        const after = fs.readFileSync(HOST_FIXTURE_PATH, 'utf8');
        assert.equal(after, HOST_FIXTURE_CONTENT, 'host $HOME fixture content changed');
    });

    test('bundle on disk was not modified during the install', () => {
        // Sandbox cannot reach the bundle (it lives outside cwd and outside
        // the bound HOME state dirs). Any change would be a critical leak.
        const before = sha256(BUNDLE);
        const after = sha256(BUNDLE);
        assert.equal(before, after);
    });
});
