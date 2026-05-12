// Build the ringfence dispatcher into two self-contained bundles — one CJS,
// one ESM — so the package can be consumed by either runtime style.
// Both targets are Node 20+, single-file, with sourcemaps and the source
// shebang preserved.
import { build } from 'esbuild';
import { chmodSync } from 'node:fs';

/** @param {'cjs' | 'esm'} format */
const targetFor = (format) => ({
    entryPoints: ['bin/ringfence.ts'],
    outfile: format === 'cjs' ? 'dist/ringfence.cjs' : 'dist/ringfence.mjs',
    bundle: true,
    platform: 'node',
    target: 'node20',
    format,
    minify: false,
    sourcemap: true,
    legalComments: 'inline',
    logLevel: 'info',
    // bin/ringfence.ts carries its own shebang line; esbuild preserves it.
});

await Promise.all([build(targetFor('cjs')), build(targetFor('esm'))]);

// Mark both as executable so the shims (which exec them directly via
// shebang) work without a separate `node ...` invocation.
chmodSync('dist/ringfence.cjs', 0o755);
chmodSync('dist/ringfence.mjs', 0o755);
