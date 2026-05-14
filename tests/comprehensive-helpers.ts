import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BUNDLE = path.join(REPO_ROOT, 'dist/ringfence.mjs');
export const PROBE = path.join(REPO_ROOT, 'tests/fixtures/leak-probe-comprehensive.cjs');
export const HOST_FIXTURE_CONTENT = 'IF-YOU-CAN-READ-THIS-THE-SANDBOX-LEAKED';
export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;

export function hostFixturePath(pm: string): string {
    return path.join(process.env.HOME!, `.ringfence-host-secret-fixture-${pm}`);
}

export type ProbeResult = { ok: boolean; value?: string; code?: string };
export type Results = Record<string, ProbeResult | string | string[] | null>;

export function bwrapAvailable(): boolean {
    try {
        execFileSync('bwrap', ['--version'], { stdio: 'ignore' });
        execFileSync('bwrap', [
            '--unshare-user-try',
            '--ro-bind', '/usr', '/usr',
            '--ro-bind-try', '/bin', '/bin',
            '--ro-bind-try', '/lib', '/lib',
            '--ro-bind-try', '/lib64', '/lib64',
            '--proc', '/proc',
            '--dev', '/dev',
            '/usr/bin/env', 'true',
        ], { stdio: 'ignore', timeout: 5000 });
        return true;
    } catch {
        return false;
    }
}

export function pmAvailable(pm: string): boolean {
    try {
        const r = execFileSync('which', [pm], { encoding: 'utf8', stdio: 'pipe' });
        return r.trim().length > 0;
    } catch {
        return false;
    }
}

export function isLeak(p: ProbeResult | string | string[] | null): boolean {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
    return (p as ProbeResult).ok === true;
}

export function probeVal(p: ProbeResult | string | string[] | null): ProbeResult {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, code: 'UNKNOWN' };
    return p as ProbeResult;
}

export async function createShimDir(): Promise<string> {
    return path.join(process.env.HOME!, '.ringfence', 'bin');
}

export async function createProject(workdir: string, pm: string): Promise<void> {
await fsp.mkdir(workdir, { recursive: true });
    await fsp.copyFile(PROBE, path.join(workdir, 'leak-probe.cjs'));
    const secrets: Array<[string, string]> = [
        ['.env', 'DB_PASSWORD=hunter2\nAPI_KEY=preshared-zZz\n'],
        ['.env.local', 'LOCAL_SECRET=override\n'],
        ['.env.production', 'PROD_KEY=super-secret\n'],
        ['prod.pem', '-----BEGIN PRIVATE KEY-----\nMOCK\n'],
        ['server.key', '-----BEGIN RSA PRIVATE KEY-----\nMOCK\n'],
        ['id_ed25519', 'fake-ssh-key-ed25519\n'],
        ['id_rsa', 'fake-ssh-key-rsa\n'],
        // .npmrc intentionally NOT planted in project — package managers
        // (especially yarn via corepack) write to it legitimately during
        // install.  The sandbox masks $HOME/.npmrc, which is the real
        // secret; project-level .npmrc is usually safe.
        ['.netrc', 'machine example.com login admin password secret\n'],
        ['credentials.json', '{"access_key": "AKIA-MOCK"}\n'],
        ['secret.yml', 'password: supersecret\n'],
        ['private.gpg', '-----BEGIN PGP PRIVATE KEY BLOCK-----\nMOCK\n'],
        ['README.md', '# Test Project\n'],
        ['index.js', 'module.exports = {};\n'],
    ];
    for (const [name, content] of secrets) {
        await fsp.writeFile(path.join(workdir, name), content);
    }
    const pkg: Record<string, unknown> = {
        name: `ringfence-comprehensive-${pm}`,
        version: '0.0.0',
        private: true,
        scripts: { preinstall: 'node leak-probe.cjs' },
        // Real dependency to verify the sandbox doesn't block
        // legitimate installs.
        dependencies: { 'state-in-url': '^1.0.0' },
    };
    if (pm === 'pnpm') pkg.packageManager = 'pnpm@11.0.0';
    else if (pm === 'yarn') pkg.packageManager = 'yarn@1.22.22';
    await fsp.writeFile(path.join(workdir, 'package.json'), JSON.stringify(pkg, null, 2));
}

export function runInstall(workdir: string, pm: string): Results {
    const env: Record<string, string> = {
        ...process.env,
        PATH: `${process.env.HOME}/.ringfence/bin:${process.env.PATH}`,
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
    execFileSync(pm, ['install'], { cwd: workdir, env, stdio: 'pipe' });
    return JSON.parse(fs.readFileSync(path.join(workdir, 'leak-results.json'), 'utf8')) as Results;
}

export async function plantHostSecrets(pm: string): Promise<void> {
    const home = process.env.HOME!;
    await fsp.writeFile(hostFixturePath(pm), HOST_FIXTURE_CONTENT);
    const D = (dir: string, files: Array<[string, string]>) => ({ dir: path.join(home, dir), files });
    const entries = [
        D('.ssh', [
            ['id_rsa', 'REAL-HOST-SSH-RSA-KEY\n'],
            ['id_ed25519', 'REAL-HOST-SSH-ED25519-KEY\n'],
            ['id_dsa', 'REAL-HOST-SSH-DSA-KEY\n'],
            ['id_ecdsa', 'REAL-HOST-SSH-ECDSA-KEY\n'],
            ['authorized_keys', 'ssh-rsa AAA...\n'],
            ['known_hosts', 'github.com ssh-rsa AAA...\n'],
            ['config', 'Host github.com\n  User git\n'],
        ]),
        D('.aws', [
            ['credentials', '[default]\naws_access_key_id=AKIA-REAL\naws_secret_access_key=wJalrXUtnFEMI/realkey\n'],
            ['config', '[default]\nregion=us-east-1\n'],
        ]),
        D('.gnupg', [['pubring.kbx', 'mock-gpg\n']]),
        D('.docker', [['config.json', '{"auths":{"https://index.docker.io/v1/":{"auth":"mock"}}}\n']]),
    ];
    for (const { dir, files } of entries) {
        await fsp.mkdir(dir, { recursive: true });
        for (const [name, content] of files) {
            await fsp.writeFile(path.join(dir, name), content);
        }
    }
    const gcloudDir = path.join(home, '.config', 'gcloud');
    await fsp.mkdir(gcloudDir, { recursive: true });
    await fsp.writeFile(path.join(gcloudDir, 'application_default_credentials.json'), '{"type":"service_account","private_key":"mock"}\n');
    await fsp.writeFile(path.join(os.tmpdir(), 'ringfence-test-tmp-secret'), 'TMP-SECRET\n');
}

export async function cleanHostSecrets(pm: string): Promise<void> {
    const home = process.env.HOME!;
    const all: string[] = [hostFixturePath(pm), path.join(os.tmpdir(), 'ringfence-test-tmp-secret')];
    for (const dir of ['.ssh', '.aws', '.gnupg', '.docker']) {
        for (const file of ['id_rsa', 'id_ed25519', 'id_dsa', 'id_ecdsa', 'authorized_keys', 'known_hosts', 'config', 'credentials', 'pubring.kbx', 'config.json']) {
            all.push(path.join(home, dir, file));
        }
    }
    all.push(path.join(home, '.config', 'gcloud', 'application_default_credentials.json'));
    for (const p of all) {
        await fsp.rm(p, { force: true }).catch(() => {});
    }
    for (const d of ['.ssh', '.aws', '.gnupg', '.docker', '.config/gcloud', '.config']) {
        await fsp.rmdir(path.join(home, d)).catch(() => {});
    }
}