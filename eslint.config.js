// Flat ESLint config (ESLint v9+).
//
// ESLint is the single formatter and linter for .ts, .js, .json, and .md
// files. Prettier is plugged in via eslint-plugin-prettier so `eslint --fix`
// formats every file type prettier knows, and eslint-config-prettier
// disables any conflicting stylistic rules.
//
// Shell scripts go through shfmt/shellcheck separately (pre-commit hook),
// since ESLint has no shell support.
import js from '@eslint/js';
import json from '@eslint/json';
import markdown from '@eslint/markdown';
import tseslint from 'typescript-eslint';
import prettierRecommended from 'eslint-plugin-prettier/recommended';

export default tseslint.config(
    {
        ignores: [
            'node_modules/',
            'dist/',
            'tests/fixtures/',
            'tests/comprehensive-helpers.ts',
            'tests/comprehensive-*.test.ts',
            '.husky/_/',
            '.claude/',
            '.agents/',
            'site/.astro/',
            'eslint.config.js',
            'scripts/build.mjs',
            'scripts/init.cjs',
            'scripts/bootstrap-template.cjs',
            'pnpm-lock.yaml',
        ],
    },

    // JS/TS — scoped so JS-style rules don't try to run on JSON/MD files.
    { files: ['**/*.{ts,js,mjs,cjs}'], ...js.configs.recommended },
    ...tseslint.configs.recommendedTypeChecked.map((c) => ({
        files: ['**/*.{ts,js,mjs,cjs}'],
        ...c,
    })),
    {
        files: ['**/*.{ts,js,mjs,cjs}'],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_',
                },
            ],
            'no-empty': ['error', { allowEmptyCatch: true }],
        },
    },
    {
        // node:test's top-level test() returns a Promise the runner tracks
        // internally; callers must NOT await it.
        files: ['tests/**/*.ts'],
        rules: {
            '@typescript-eslint/no-floating-promises': 'off',
            '@typescript-eslint/no-unnecessary-type-assertion': 'off',
        },
    },

    // JSON (no built-in rules; prettier-plugin handles formatting on --fix).
    {
        files: ['**/*.json'],
        language: 'json/json',
        plugins: { json },
    },
    {
        files: ['**/*.jsonc', '.vscode/**/*.json'],
        language: 'json/jsonc',
        plugins: { json },
    },

    // Markdown
    {
        files: ['**/*.md'],
        language: 'markdown/gfm',
        plugins: { markdown },
    },

    // Prettier must come last so its disables override anything above and
    // its plugin rule applies to every file type matched above.
    prettierRecommended,
    {
        rules: {
            'prettier/prettier': 'warn',
        },
    },
);
