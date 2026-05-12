// Runs as the `preinstall` script of a synthetic package inside the
// sandbox. Tries every leak path a malicious third-party install script
// would attempt, then writes the outcomes to leak-results.json (in the
// project dir, which IS bound rw into the sandbox).
//
// Each probe records either { ok: true, value: ... } (LEAK — security
// violation) or { ok: false, code: 'EACCES' | 'ENOENT' | ... } (BLOCKED).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function tryReadFile(p) {
    try {
        return { ok: true, value: fs.readFileSync(p, 'utf8') };
    } catch (e) {
        return { ok: false, code: e.code };
    }
}

function tryListDir(p) {
    try {
        return { ok: true, value: fs.readdirSync(p) };
    } catch (e) {
        return { ok: false, code: e.code };
    }
}

const home = process.env.HOME || os.homedir();

const results = {
    // Project-local secrets — these must be masked inside the sandbox.
    project_env: tryReadFile('.env'),
    project_pem: tryReadFile('prod.pem'),
    project_sshkey: tryReadFile('id_ed25519'),

    // Host $HOME files — sandbox runs with $HOME as tmpfs, none of the
    // host's home content should be visible.
    home_bashrc: tryReadFile(path.join(home, '.bashrc')),
    home_zshrc: tryReadFile(path.join(home, '.zshrc')),
    home_ssh_dir: tryListDir(path.join(home, '.ssh')),
    home_aws_dir: tryListDir(path.join(home, '.aws')),
    home_gnupg_dir: tryListDir(path.join(home, '.gnupg')),
    host_planted_secret: tryReadFile(path.join(home, '.safenpm-host-sec-test')),

    // Secret-shaped env vars — should all be unset inside the sandbox.
    env_aws: process.env.AWS_SECRET_ACCESS_KEY ?? null,
    env_npm_token: process.env.NPM_TOKEN ?? null,
    env_github_token: process.env.GITHUB_TOKEN ?? null,
    env_db_password: process.env.DATABASE_PASSWORD ?? null,
    env_generic_secret: process.env.MY_API_SECRET ?? null,

    // Non-secret env vars — should pass through.
    env_ci_flag: process.env.SAFENPM_TEST_HARMLESS ?? null,

    // Process / runtime sanity.
    cwd: process.cwd(),
    home_env: process.env.HOME,
    home_entries: tryListDir(home).value || null,
};

fs.writeFileSync('leak-results.json', JSON.stringify(results, null, 2));
