// Build the ringfence dispatcher into a self-contained ESM bundle.
// Targets Node 20+, single-file, with sourcemaps.
import { build } from 'esbuild';
import { chmodSync } from 'node:fs';

await build({
    entryPoints: ['bin/ringfence.ts'],
    outfile: 'dist/ringfence.mjs',
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    minify: false,
    sourcemap: true,
    legalComments: 'inline',
    logLevel: 'info',
});

chmodSync('dist/ringfence.mjs', 0o755);
