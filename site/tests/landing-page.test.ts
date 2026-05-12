// Test that the Astro site builds and produces expected content.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SITE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = path.join(SITE_DIR, 'dist');
const INDEX_HTML = path.join(DIST_DIR, 'index.html');

test('site builds, contains expected sections, and links CSS', () => {
    execFileSync('npm', ['run', 'build'], {
        cwd: SITE_DIR,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        stdio: 'pipe',
    });

    const html = fs.readFileSync(INDEX_HTML, 'utf8');

    assert.match(html, /Install packages/);
    assert.match(html, /Not threats/);
    assert.match(html, /TanStack supply-chain worm/);
    assert.match(html, /bwrap sandbox/);
    assert.match(html, /npm install.*express/);
    assert.match(html, /pnpm add.*zod/);
    assert.match(html, /yarn add.*react/);
    assert.match(html, /bun add.*@hono\/hono/);
    assert.match(html, /curl -fsSL https:\/\/safenpm.dev\/install.sh/);
    assert.match(html, /MIT license/);
    assert.match(html, /<link rel="stylesheet" href="\/_astro\/index\.[^"]+\.css">/);
});