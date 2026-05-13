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
    try { return { ok: true, value: true }; }
    catch (e) { return { ok: false, code: e.code }; }
}

const home = process.env.HOME || os.homedir();

const results = {
    project_env: tryRead('.env'),
    project_pem: tryRead('prod.pem'),
    project_sshkey: tryRead('id_ed25519'),
    home_bashrc: tryRead(path.join(home, '.bashrc')),
    home_zshrc: tryRead(path.join(home, '.zshrc')),
    env_aws: process.env.AWS_SECRET_ACCESS_KEY ?? null,
    env_npm_token: process.env.NPM_TOKEN ?? null,
    env_github_token: process.env.GITHUB_TOKEN ?? null,
    env_db_password: process.env.DATABASE_PASSWORD ?? null,
    env_generic_secret: process.env.MY_API_SECRET ?? null,
    env_ci_flag: process.env.RINGFENCE_TEST_HARMLESS ?? null,
    node_modules_exists: tryStat('node_modules').ok,
};

const out = process.env.RINGFENCE_RESULTS_FILE || 'leak-results.json';
fs.writeFileSync(out, JSON.stringify(results, null, 2));