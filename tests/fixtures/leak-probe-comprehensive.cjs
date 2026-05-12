#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function tryRead(p) {
    try { return { ok: true, value: fs.readFileSync(p, 'utf8') }; }
    catch (e) { return { ok: false, code: e.code }; }
}

function tryList(p) {
    try { return { ok: true, value: fs.readdirSync(p) }; }
    catch (e) { return { ok: false, code: e.code }; }
}

function tryStat(p) {
    try { return { ok: true, value: fs.statSync(p) }; }
    catch (e) { return { ok: false, code: e.code }; }
}

function tryWrite(p, data) {
    try {
        fs.writeFileSync(p, data);
        return true;
    } catch (e) {
        return false;
    }
}

const home = process.env.HOME || os.homedir();
const project = process.cwd();
const osTmp = os.tmpdir();

const results = {
    // ----- Project-local secrets (should be masked / inaccessible) -----
    project_dotenv: tryRead(path.join(project, '.env')),
    project_dotenv_local: tryRead(path.join(project, '.env.local')),
    project_dotenv_production: tryRead(path.join(project, '.env.production')),
    project_pem: tryRead(path.join(project, 'prod.pem')),
    project_key: tryRead(path.join(project, 'server.key')),
    project_sshkey_ed25519: tryRead(path.join(project, 'id_ed25519')),
    project_sshkey_rsa: tryRead(path.join(project, 'id_rsa')),
    project_npmrc: tryRead(path.join(project, '.npmrc')),
    project_netrc: tryRead(path.join(project, '.netrc')),
    project_credentials_json: tryRead(path.join(project, 'credentials.json')),
    project_secret_yml: tryRead(path.join(project, 'secret.yml')),
    project_gpg_key: tryRead(path.join(project, 'private.gpg')),

    // ----- Non-secret project files (should be readable normally) -----
    project_readme: tryRead(path.join(project, 'README.md')),
    project_index_js: tryRead(path.join(project, 'index.js')),

    // ----- Host $HOME (tmpfs, should not expose real home) -----
    home_bashrc: tryRead(path.join(home, '.bashrc')),
    home_zshrc: tryRead(path.join(home, '.zshrc')),
    home_profile: tryRead(path.join(home, '.profile')),
    home_planted_secret: tryRead(path.join(home, '.ringfence-host-secret-fixture-' + (process.env.RINGFENCE_TEST_PM || 'default'))),

    // ----- ~/.ssh directory (should be empty/ENOENT inside sandbox) -----
    home_ssh_dir: tryList(path.join(home, '.ssh')),
    home_ssh_id_rsa: tryRead(path.join(home, '.ssh', 'id_rsa')),
    home_ssh_id_ed25519: tryRead(path.join(home, '.ssh', 'id_ed25519')),
    home_ssh_id_dsa: tryRead(path.join(home, '.ssh', 'id_dsa')),
    home_ssh_id_ecdsa: tryRead(path.join(home, '.ssh', 'id_ecdsa')),
    home_ssh_authorized_keys: tryRead(path.join(home, '.ssh', 'authorized_keys')),
    home_ssh_known_hosts: tryRead(path.join(home, '.ssh', 'known_hosts')),
    home_ssh_config: tryRead(path.join(home, '.ssh', 'config')),

    // ----- ~/.aws directory -----
    home_aws_dir: tryList(path.join(home, '.aws')),
    home_aws_credentials: tryRead(path.join(home, '.aws', 'credentials')),
    home_aws_config: tryRead(path.join(home, '.aws', 'config')),

    // ----- ~/.gnupg directory -----
    home_gnupg_dir: tryList(path.join(home, '.gnupg')),

    // ----- ~/.docker -----
    home_docker_dir: tryList(path.join(home, '.docker')),
    home_docker_config: tryRead(path.join(home, '.docker', 'config.json')),

    // ----- ~/.config/gcloud -----
    home_gcloud_dir: tryList(path.join(home, '.config', 'gcloud')),
    home_gcloud_creds: tryRead(path.join(home, '.config', 'gcloud', 'application_default_credentials.json')),

    // ----- /tmp isolation -----
    tmp_planted: tryRead(path.join(osTmp, 'ringfence-test-tmp-secret')),
    tmp_can_write: tryWrite(path.join(osTmp, 'ringfence-test-exfil'), 'stolen-data'),

    // ----- /proc / sys access (should be readable — system info, not secret) -----
    proc_version: tryRead('/proc/version'),
    proc_uptime: tryRead('/proc/uptime'),

    // ----- Secret-shaped env vars (should be null) -----
    env_aws_key: process.env.AWS_SECRET_ACCESS_KEY ?? null,
    env_aws_session: process.env.AWS_SESSION_TOKEN ?? null,
    env_npm_token: process.env.NPM_TOKEN ?? null,
    env_npm_auth: process.env.NPM_AUTH_TOKEN ?? null,
    env_github_token: process.env.GITHUB_TOKEN ?? null,
    env_github_pat: process.env.GH_TOKEN ?? null,
    env_db_password: process.env.DATABASE_PASSWORD ?? null,
    env_db_url: process.env.DATABASE_URL ?? null,
    env_redis_password: process.env.REDIS_PASSWORD ?? null,
    env_api_key: process.env.API_KEY ?? null,
    env_api_secret: process.env.MY_API_SECRET ?? null,
    env_ssh_key: process.env.SSH_PRIVATE_KEY ?? null,
    env_netrc: process.env.MACHINE_TOKEN ?? null,
    env_npmrc_token: process.env.NPM_CONFIG__AUTH ?? null,
    env_pnpm_token: process.env.PNPM_TOKEN ?? null,
    env_yarn_token: process.env.YARN_TOKEN ?? null,
    env_bun_token: process.env.BUN_TOKEN ?? null,
    env_docker_token: process.env.DOCKER_TOKEN ?? null,
    env_sentry_token: process.env.SENTRY_AUTH_TOKEN ?? null,
    env_vercel_token: process.env.VERCEL_TOKEN ?? null,
    env_cf_token: process.env.CLOUDFLARE_API_TOKEN ?? null,
    env_stripe_key: process.env.STRIPE_SECRET_KEY ?? null,
    env_twilio_sid: process.env.TWILIO_ACCOUNT_SID ?? null,
    env_heroku_api: process.env.HEROKU_API_KEY ?? null,

    // ----- Non-secret env vars (should pass through) -----
    env_harmless: process.env.RINGFENCE_TEST_HARMLESS ?? null,
    env_path: process.env.PATH ? 'present' : null,
    env_user: process.env.USER ?? null,

    // ----- Sandbox $HOME contents -----
    home_entries: tryList(home).ok ? tryList(home).value : null,

    // ----- Process sanity -----
    cwd: process.cwd(),
    home_env: home,
    uid: process.getuid(),
    hostname: (() => { try { return require('node:os').hostname(); } catch { return null; } })(),
};

fs.writeFileSync(path.join(project, 'leak-results.json'), JSON.stringify(results, null, 2));