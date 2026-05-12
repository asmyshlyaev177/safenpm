import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    BUNDLE, PROBE, HOST_FIXTURE_CONTENT,
    bwrapAvailable, pmAvailable, isLeak, probeVal,
    createShimDir, createProject, runInstall,
    plantHostSecrets, cleanHostSecrets, hostFixturePath, type Results,
} from './comprehensive-helpers.ts';

const PM = 'yarn';
const skip = !bwrapAvailable() ? 'requires bwrap with user ns support' :
    !fs.existsSync(BUNDLE) ? 'run pnpm build first' :
    !pmAvailable(PM) ? `${PM} not on PATH` : false;

let testRoot: string;
let workdir: string;
let safenpmHome: string;
let shimDir: string;
let results: Results;
let fixtureFile: string;

before(async () => {
    if (skip) return;
    fixtureFile = hostFixturePath(PM);
    await plantHostSecrets(PM);
    testRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `safenpm-comp-${PM}-`));
    safenpmHome = path.join(testRoot, 'safenpm');
    shimDir = await createShimDir(safenpmHome);
    workdir = path.join(testRoot, 'project');
    await createProject(workdir, PM);
    results = runInstall(workdir, safenpmHome, shimDir, PM);
});

after(async () => {
    if (skip) return;
    await fsp.rm(testRoot, { recursive: true, force: true }).catch(() => {});
    await cleanHostSecrets(PM);
});

// ----- Project-local secrets -----
test(`${PM}: cannot read .env`, { skip }, () => {
    assert.equal(isLeak(results.project_dotenv), false);
    assert.equal(probeVal(results.project_dotenv).code, 'EACCES');
});
test(`${PM}: cannot read .env.local`, { skip }, () => assert.equal(isLeak(results.project_dotenv_local), false));
test(`${PM}: cannot read .env.production`, { skip }, () => assert.equal(isLeak(results.project_dotenv_production), false));
test(`${PM}: cannot read .pem`, { skip }, () => {
    assert.equal(isLeak(results.project_pem), false);
    assert.equal(isLeak(results.project_key), false);
});
test(`${PM}: cannot read SSH keys`, { skip }, () => {
    assert.equal(isLeak(results.project_sshkey_ed25519), false);
    assert.equal(isLeak(results.project_sshkey_rsa), false);
});
test(`${PM}: cannot read .npmrc`, { skip }, () => assert.equal(isLeak(results.project_npmrc), false));
test(`${PM}: cannot read .netrc`, { skip }, () => assert.equal(isLeak(results.project_netrc), false));
test(`${PM}: cannot read credentials.json`, { skip }, () => assert.equal(isLeak(results.project_credentials_json), false));
test(`${PM}: cannot read secret.yml`, { skip }, () => assert.equal(isLeak(results.project_secret_yml), false));
test(`${PM}: cannot read .gpg`, { skip }, () => assert.equal(isLeak(results.project_gpg_key), false));

// ----- Non-secret files readable -----
test(`${PM}: can read README.md`, { skip }, () => {
    assert.ok(isLeak(results.project_readme));
    assert.ok(probeVal(results.project_readme).value?.includes('Test Project'));
});
test(`${PM}: can read index.js`, { skip }, () => assert.ok(isLeak(results.project_index_js)));

// ----- Host $HOME -----
test(`${PM}: cannot read ~/.bashrc`, { skip }, () => assert.equal(isLeak(results.home_bashrc), false));
test(`${PM}: cannot read ~/.zshrc`, { skip }, () => assert.equal(isLeak(results.home_zshrc), false));
test(`${PM}: cannot read planted host secret`, { skip }, () => assert.equal(isLeak(results.home_planted_secret), false));

// ----- ~/.ssh -----
test(`${PM}: cannot list ~/.ssh`, { skip }, () => assert.equal(isLeak(results.home_ssh_dir), false));
test(`${PM}: cannot read ~/.ssh/id_rsa`, { skip }, () => assert.equal(isLeak(results.home_ssh_id_rsa), false));
test(`${PM}: cannot read ~/.ssh/id_ed25519`, { skip }, () => assert.equal(isLeak(results.home_ssh_id_ed25519), false));

// ----- ~/.aws -----
test(`${PM}: cannot list ~/.aws`, { skip }, () => assert.equal(isLeak(results.home_aws_dir), false));
test(`${PM}: cannot read ~/.aws/credentials`, { skip }, () => assert.equal(isLeak(results.home_aws_credentials), false));

// ----- ~/.gnupg, ~/.docker, gcloud -----
test(`${PM}: cannot list ~/.gnupg`, { skip }, () => assert.equal(isLeak(results.home_gnupg_dir), false));
test(`${PM}: cannot list ~/.docker`, { skip }, () => assert.equal(isLeak(results.home_docker_dir), false));
test(`${PM}: cannot read ~/.docker/config.json`, { skip }, () => assert.equal(isLeak(results.home_docker_config), false));
test(`${PM}: cannot read gcloud creds`, { skip }, () => assert.equal(isLeak(results.home_gcloud_creds), false));

// ----- /tmp isolation -----
test(`${PM}: cannot read /tmp planted secret`, { skip }, () => assert.equal(isLeak(results.tmp_planted), false));

// ----- Env vars stripped -----
test(`${PM}: AWS_SECRET_ACCESS_KEY unset`, { skip }, () => assert.equal(results.env_aws_key, null));
test(`${PM}: NPM_TOKEN unset`, { skip }, () => assert.equal(results.env_npm_token, null));
test(`${PM}: GITHUB_TOKEN unset`, { skip }, () => assert.equal(results.env_github_token, null));
test(`${PM}: DATABASE_PASSWORD unset`, { skip }, () => assert.equal(results.env_db_password, null));
test(`${PM}: SSH_PRIVATE_KEY unset`, { skip }, () => assert.equal(results.env_ssh_key, null));
test(`${PM}: STRIPE_SECRET_KEY unset`, { skip }, () => assert.equal(results.env_stripe_key, null));

// ----- Non-secret env vars pass through -----
test(`${PM}: harmless env passes through`, { skip }, () => assert.equal(results.env_harmless, 'harmless-flag-passes-through'));

// ----- Sandbox integrity -----
test(`${PM}: host .env unmodified`, { skip }, () => {
    const after = fs.readFileSync(path.join(workdir, '.env'), 'utf8');
    assert.equal(after, 'DB_PASSWORD=hunter2\nAPI_KEY=preshared-zZz\n');
});
test(`${PM}: host fixture unmodified`, { skip }, () => {
    assert.equal(fs.readFileSync(fixtureFile, 'utf8'), HOST_FIXTURE_CONTENT);
});
test(`${PM}: sandbox HOME hides host secrets`, { skip }, () => {
    const entries = results.home_entries as string[] | null;
    const fixtureName = path.basename(fixtureFile);
    assert.ok(entries !== null);
    assert.ok(!entries.includes(fixtureName), `${fixtureName} visible in sandbox HOME`);
    for (const f of ['.ssh', '.aws', '.gnupg', '.docker']) {
        assert.ok(!entries.includes(f), `${f} visible in sandbox HOME`);
    }
});

// ----- Process sanity -----
test(`${PM}: has valid uid`, { skip }, () => {
    assert.ok(Number(results.uid) >= 0, 'sandbox should have a valid uid');
});
test(`${PM}: state-in-url dependency was installed`, { skip }, () => {
    const pj = JSON.parse(fs.readFileSync(path.join(workdir, "node_modules", "state-in-url", "package.json"), "utf8"));
    assert.ok(pj.name === "state-in-url", "state-in-url should be installed");
  });
test(`${PM}: hostname is safenpm-sandbox`, { skip }, () => assert.equal(results.hostname, 'safenpm-sandbox'));