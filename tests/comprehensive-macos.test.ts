// Comprehensive security tests for the macOS Docker-based sandbox.
// Tests npm, pnpm, yarn, and bun via runMacos() directly.
//
// Requires Docker daemon. Run inside the macOS test Docker image or on a
// host with Docker available.
//
//   pnpm run test:macos

import { describe, test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runMacos, dockerAvailable } from '../lib/sandbox-macos.ts';
import {
    HOST_FIXTURE_CONTENT,
    isLeak, probeVal,
    createProject,
    plantHostSecrets, cleanHostSecrets, hostFixturePath, type Results,
} from './comprehensive-helpers.ts';

const skipSuite =
    process.platform === 'win32'
        ? 'macOS sandbox tests do not support Windows'
        : !dockerAvailable()
          ? 'macOS sandbox tests require Docker on PATH'
          : false;

async function runMacosInstall(workdir: string, pm: string): Promise<Results> {
    const env: Record<string, string> = {
        AWS_SECRET_ACCESS_KEY: 'AKIA-planted-leak-me',
        AWS_SESSION_TOKEN: 'IQoJb3JpZ2luX2VY-mock',
        NPM_TOKEN: 'npm_planted_leak',
        NPM_AUTH_TOKEN: 'npm_auth_planted',
        GITHUB_TOKEN: 'ghp_planted_leak',
        GH_TOKEN: 'gh_planted_leak',
        DATABASE_PASSWORD: 'planted-db-leak',
        DATABASE_URL: 'postgres://user:pass@host/db',
        REDIS_PASSWORD: 'planted-redis-leak',
        API_KEY: 'ak-planted-leak',
        MY_API_SECRET: 'planted-generic-secret',
        SSH_PRIVATE_KEY: 'planted-ssh-key',
        MACHINE_TOKEN: 'mt-planted-leak',
        NPM_CONFIG__AUTH: 'planted-npm-auth',
        PNPM_TOKEN: 'pnpm_planted_leak',
        YARN_TOKEN: 'yarn_planted_leak',
        BUN_TOKEN: 'bun_planted_leak',
        DOCKER_TOKEN: 'dckr_planted_leak',
        SENTRY_AUTH_TOKEN: 'sntry_planted_leak',
        VERCEL_TOKEN: 'vrcel_planted_leak',
        CLOUDFLARE_API_TOKEN: 'cf_planted_leak',
        STRIPE_SECRET_KEY: 'sk_planted_leak',
        TWILIO_ACCOUNT_SID: 'AC_planted_leak',
        HEROKU_API_KEY: 'hk_planted_leak',
        RINGFENCE_TEST_HARMLESS: 'harmless-flag-passes-through',
        RINGFENCE_TEST_PM: pm,
    };

    for (const [k, v] of Object.entries(env)) {
        process.env[k] = v;
    }

    try {
        const exitCode = await runMacos({
            pm: pm as 'npm' | 'pnpm' | 'yarn' | 'bun',
            realBin: '/usr/bin/env',
            workdir,
            args: ['install'],
            ringfenceHome: '/tmp/ringfence-test-home',
        });

        assert.equal(exitCode, 0, `runMacos ${pm} install exited with code ${exitCode}`);

        return JSON.parse(
            fs.readFileSync(path.join(workdir, 'leak-results.json'), 'utf8'),
        ) as Results;
    } finally {
        for (const k of Object.keys(env)) {
            delete process.env[k];
        }
    }
}

// Verify the full round-trip: secrets excluded → install in container →
// results synced back → project is fully usable (deps installed, scripts work).
describe('macOS sandbox: post-install project is usable', { skip: skipSuite || undefined }, () => {
    let testRoot: string;
    let workdir: string;

    before(async () => {
        testRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ringfence-macos-post-'));
        workdir = path.join(testRoot, 'project');
        await fsp.mkdir(workdir);

        await fsp.writeFile(
            path.join(workdir, 'package.json'),
            JSON.stringify(
                {
                    name: 'ringfence-macos-post-test',
                    version: '0.0.0',
                    private: true,
                    scripts: { test: 'node -e "require(\'fs\').existsSync(\'./node_modules/state-in-url/package.json\') && console.log(\'OK\')"' },
                    dependencies: { 'state-in-url': '^1.0.0' },
                },
                null,
                2,
            ),
        );

        const exitCode = await runMacos({
            pm: 'npm',
            realBin: '/usr/bin/env',
            workdir,
            args: ['install'],
            ringfenceHome: '/tmp/ringfence-test-home',
        });
        assert.equal(exitCode, 0, 'npm install via runMacos should succeed');
    });

    after(async () => {
        await fsp.rm(testRoot, { recursive: true, force: true }).catch(() => {});
    });

    test('state-in-url installed correctly', () => {
        const pj = JSON.parse(
            fs.readFileSync(path.join(workdir, 'node_modules', 'state-in-url', 'package.json'), 'utf8'),
        );
        assert.equal(pj.name, 'state-in-url');
    });

    test('npm test runs successfully after sandboxed install', () => {
        const out = execFileSync('npm', ['test'], { cwd: workdir, encoding: 'utf8', stdio: 'pipe' });
        assert.ok(out.includes('OK'), 'npm test should print OK');
    });
});

function makeSuite(name: string, pm: string) {
    const skip =
        skipSuite ||
        (pm !== 'npm' && pm !== 'pnpm' && pm !== 'yarn' && pm !== 'bun'
            ? `unknown pm: ${pm}`
            : false);

    describe(`macOS sandbox: ${name}`, { skip: skip || undefined }, () => {
        let testRoot: string;
        let workdir: string;
        let results: Results;
        let fixtureFile: string;

        before(async () => {
            fixtureFile = hostFixturePath(pm);
            await plantHostSecrets(pm);
            testRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `ringfence-macos-comp-${pm}-`));
            workdir = path.join(testRoot, 'project');
            await createProject(workdir, pm);
            results = await runMacosInstall(workdir, pm);
        });

        after(async () => {
            await fsp.rm(testRoot, { recursive: true, force: true }).catch(() => {});
            await cleanHostSecrets(pm);
        });

        // ----- Project-local secrets -----
        test(`${pm}: cannot read .env`, () => {
            assert.equal(isLeak(results.project_dotenv), false);
            assert.equal(probeVal(results.project_dotenv).code, 'ENOENT');
        });
        test(`${pm}: cannot read .env.local`, () => assert.equal(isLeak(results.project_dotenv_local), false));
        test(`${pm}: cannot read .env.production`, () => assert.equal(isLeak(results.project_dotenv_production), false));
        test(`${pm}: cannot read .pem`, () => {
            assert.equal(isLeak(results.project_pem), false);
            assert.equal(isLeak(results.project_key), false);
        });
        test(`${pm}: cannot read SSH keys`, () => {
            assert.equal(isLeak(results.project_sshkey_ed25519), false);
            assert.equal(isLeak(results.project_sshkey_rsa), false);
        });
        test(`${pm}: cannot read .netrc`, () => assert.equal(isLeak(results.project_netrc), false));
        test(`${pm}: cannot read credentials.json`, () => assert.equal(isLeak(results.project_credentials_json), false));
        test(`${pm}: cannot read secret.yml`, () => assert.equal(isLeak(results.project_secret_yml), false));
        test(`${pm}: cannot read .gpg`, () => assert.equal(isLeak(results.project_gpg_key), false));

        // ----- Non-secret files readable -----
        test(`${pm}: can read README.md`, () => {
            assert.ok(isLeak(results.project_readme));
            assert.ok(probeVal(results.project_readme).value?.includes('Test Project'));
        });
        test(`${pm}: can read index.js`, () => assert.ok(isLeak(results.project_index_js)));

        // ----- Env vars stripped -----
        test(`${pm}: AWS_SECRET_ACCESS_KEY unset`, () => assert.equal(results.env_aws_key, null));
        test(`${pm}: NPM_TOKEN unset`, () => assert.equal(results.env_npm_token, null));
        test(`${pm}: GITHUB_TOKEN unset`, () => assert.equal(results.env_github_token, null));
        test(`${pm}: DATABASE_PASSWORD unset`, () => assert.equal(results.env_db_password, null));
        test(`${pm}: SSH_PRIVATE_KEY unset`, () => assert.equal(results.env_ssh_key, null));
        test(`${pm}: STRIPE_SECRET_KEY unset`, () => assert.equal(results.env_stripe_key, null));

        // ----- Non-secret env vars pass through -----
        test(`${pm}: harmless env passes through`, () => assert.equal(results.env_harmless, 'harmless-flag-passes-through'));

        // ----- Sandbox $HOME isolation -----
        test(`${pm}: sandbox $HOME is /work`, () => assert.equal(results.home_env, '/work'));
        test(`${pm}: sandbox cwd is /work`, () => assert.equal(results.cwd, '/work'));

        // ----- Host integrity -----
        test(`${pm}: host .env unmodified`, () => {
            const after = fs.readFileSync(path.join(workdir, '.env'), 'utf8');
            assert.equal(after, 'DB_PASSWORD=hunter2\nAPI_KEY=preshared-zZz\n');
        });
        test(`${pm}: host fixture unmodified`, () => {
            assert.equal(fs.readFileSync(fixtureFile, 'utf8'), HOST_FIXTURE_CONTENT);
        });

        // ----- Dependencies actually installed -----
        test(`${pm}: state-in-url dependency was installed`, () => {
            const pj = JSON.parse(
                fs.readFileSync(path.join(workdir, 'node_modules', 'state-in-url', 'package.json'), 'utf8'),
            );
            assert.equal(pj.name, 'state-in-url');
        });
    });
}

makeSuite('npm', 'npm');
makeSuite('pnpm', 'pnpm');
makeSuite('yarn', 'yarn');
makeSuite('bun', 'bun');