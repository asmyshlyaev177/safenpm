import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { composeContainerCmd, shellQuote, makeCopyFilter } from '../lib/sandbox-macos.ts';

test('shellQuote: safe strings (alphanumeric + common safe chars) pass through unchanged', () => {
    assert.equal(shellQuote('npm'), 'npm');
    assert.equal(shellQuote('install'), 'install');
    assert.equal(shellQuote('--save-dev'), '--save-dev');
    assert.equal(shellQuote('lodash@4.17.21'), 'lodash@4.17.21');
    assert.equal(shellQuote('test=value:ok+data'), 'test=value:ok+data');
});

test('shellQuote: wraps strings with spaces in single quotes', () => {
    assert.equal(shellQuote('hello world'), "'hello world'");
    assert.equal(shellQuote('arg with spaces'), "'arg with spaces'");
});

test('shellQuote: escapes single quotes inside the string', () => {
    assert.equal(shellQuote("it's"), "'it'\\''s'");
    assert.equal(shellQuote("don't panic"), "'don'\\''t panic'");
});

test('shellQuote: handles special shell characters', () => {
    assert.ok(shellQuote('$(whoami)').startsWith("'"));
    assert.ok(shellQuote('`id`').startsWith("'"));
    assert.ok(shellQuote('a|b').startsWith("'"));
    assert.ok(shellQuote('a&b').startsWith("'"));
    assert.ok(shellQuote('a>b').startsWith("'"));
});

test('shellQuote: empty string is quoted', () => {
    assert.equal(shellQuote(''), "''");
});

test('composeContainerCmd: npm produces plain npm command', () => {
    assert.equal(composeContainerCmd('npm', ['install']), 'npm install');
    assert.equal(composeContainerCmd('npm', ['install', 'lodash']), 'npm install lodash');
    assert.equal(
        composeContainerCmd('npm', ['install', 'pkg with spaces']),
        "npm install 'pkg with spaces'",
    );
});

test('composeContainerCmd: pnpm uses corepack wrapper', () => {
    const cmd = composeContainerCmd('pnpm', ['install']);
    assert.ok(cmd.includes('corepack enable'), 'pnpm cmd should enable corepack');
    assert.ok(cmd.includes('corepack pnpm install'), 'pnpm cmd should run via corepack');
});

test('composeContainerCmd: yarn uses corepack wrapper', () => {
    const cmd = composeContainerCmd('yarn', ['install']);
    assert.ok(cmd.includes('corepack enable'), 'yarn cmd should enable corepack');
    assert.ok(cmd.includes('corepack yarn install'), 'yarn cmd should run via corepack');
});

test('composeContainerCmd: bun produces plain bun command', () => {
    assert.equal(composeContainerCmd('bun', ['install']), 'bun install');
    assert.equal(composeContainerCmd('bun', ['add', 'lodash']), 'bun add lodash');
});

test('makeCopyFilter: passes through non-secret filenames', () => {
    const filter = makeCopyFilter(false);
    assert.equal(filter('/some/path/package.json'), true);
    assert.equal(filter('/some/path/index.ts'), true);
    assert.equal(filter('/some/path/node_modules'), true);
});

test('makeCopyFilter: blocks .env files', () => {
    const filter = makeCopyFilter(false);
    assert.equal(filter('/some/path/.env'), false);
    assert.equal(filter('/some/path/.env.local'), false);
    assert.equal(filter('/some/path/.env.production'), false);
    assert.equal(filter('/some/path/something.env'), false);
});

test('makeCopyFilter: blocks .pem and key files', () => {
    const filter = makeCopyFilter(false);
    assert.equal(filter('/some/path/prod.pem'), false);
    assert.equal(filter('/some/path/server.key'), false);
    assert.equal(filter('/some/path/cert.crt'), false);
});

test('makeCopyFilter: blocks SSH key files', () => {
    const filter = makeCopyFilter(false);
    assert.equal(filter('/some/path/id_rsa'), false);
    assert.equal(filter('/some/path/id_ed25519'), false);
    assert.equal(filter('/some/path/id_ecdsa.pub'), false);
});

test('makeCopyFilter: blocks credential files', () => {
    const filter = makeCopyFilter(false);
    assert.equal(filter('/some/path/credentials.json'), false);
    assert.equal(filter('/some/path/secrets.yaml'), false);
    assert.equal(filter('/some/path/secret.yml'), false);
});

test('makeCopyFilter: blocks gcloud/aws credential files', () => {
    const filter = makeCopyFilter(false);
    assert.equal(filter('/some/path/gcloud-keyfile.json'), false);
    assert.equal(filter('/some/path/service-account-abc.json'), false);
    assert.equal(filter('/some/path/application_default_credentials.json'), false);
    assert.equal(filter('/some/path/aws-credentials'), false);
    assert.equal(filter('/some/path/aws-config'), false);
});

test('makeCopyFilter: with rejectAuxConfig=true blocks pm config files', () => {
    const filter = makeCopyFilter(true);
    assert.equal(filter('/some/path/.npmrc'), false);
    assert.equal(filter('/some/path/.yarnrc'), false);
    assert.equal(filter('/some/path/.yarnrc.yml'), false);
});

test('makeCopyFilter: with rejectAuxConfig=false allows pm config files', () => {
    const filter = makeCopyFilter(false);
    assert.equal(filter('/some/path/.npmrc'), true);
    assert.equal(filter('/some/path/.yarnrc'), true);
    assert.equal(filter('/some/path/.yarnrc.yml'), true);
});
