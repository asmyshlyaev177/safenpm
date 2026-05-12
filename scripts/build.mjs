// Build the safenpm dispatcher into two self-contained bundles — one CJS,
// one ESM — so the package can be consumed by either runtime style.
// Both targets are Node 20+, single-file, with sourcemaps and the source
// shebang preserved.
import { build } from 'esbuild';
import { chmodSync } from 'node:fs';

/** @param {'cjs' | 'esm'} format */
const targetFor = (format) => ({
    entryPoints: ['bin/safenpm.ts'],
    outfile: format === 'cjs' ? 'dist/safenpm.cjs' : 'dist/safenpm.mjs',
    bundle: true,
    platform: 'node',
    target: 'node20',
    format,
    minify: false,
    sourcemap: true,
    legalComments: 'inline',
    logLevel: 'info',
    // bin/safenpm.ts carries its own shebang line; esbuild preserves it.
});

await Promise.all([build(targetFor('cjs')), build(targetFor('esm'))]);

// Mark both as executable so the shims (which exec them directly via
// shebang) work without a separate `node ...` invocation.
chmodSync('dist/safenpm.cjs', 0o755);
chmodSync('dist/safenpm.mjs', 0o755);
