import { readdir } from 'node:fs/promises';
import * as path from 'node:path';

// Filename patterns (matched against basename, case-insensitive) that mark a
// file as sensitive. Keep this in lockstep with the rsync excludes in
// sandbox-macos.ts.
const SECRET_FILE_PATTERNS: readonly RegExp[] = [
    /^\.env$/i,
    /^\.env\..+/i,
    /\.env$/i,
    /^\.envrc$/i,
    /^\.netrc$/i,
    /^_netrc$/i,
    /^\.pgpass$/i,
    /^\.my\.cnf$/i,
    /^credentials(\..+)?$/i,
    /^secrets?(\..+)?$/i,
    /secret.*\.(json|ya?ml)$/i,
    /\.(pem|key|crt|cer|pfx|p12|jks|keystore)$/i,
    /^id_(rsa|dsa|ecdsa|ed25519)(\..+)?$/i,
    /^known_hosts$/i,
    /^authorized_keys$/i,
    /\.(gpg|asc)$/i,
    /^gcloud-.+\.json$/i,
    /^service-account.*\.json$/i,
    // .npmrc / .yarnrc* are NOT masked — package managers write to them
    // legitimately during install.  $HOME/.npmrc is protected by being
    // mounted read-only via homeStateDirs() instead.
];

const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git', '.pnpm-store']);

export function isSecretFilename(name: string): boolean {
    return SECRET_FILE_PATTERNS.some((r) => r.test(name));
}

export async function detectSecrets(root: string): Promise<string[]> {
    const out: string[] = [];
    async function walk(dir: string): Promise<void> {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name)) continue;
                await walk(full);
            } else if (e.isFile() || e.isSymbolicLink()) {
                if (isSecretFilename(e.name)) out.push(full);
            }
        }
    }
    await walk(root);
    return out;
}

// Env-var name patterns. Substring matches are case-insensitive.
const SECRET_NAME_SUBSTRINGS: readonly RegExp[] = [
    /TOKEN/i,
    /SECRET/i,
    /PASSWORD/i,
    /PASSWD/i,
    /API_?KEY/i,
    /PRIVATE_?KEY/i,
    /ACCESS_?KEY/i,
    /CREDENTIAL/i,
    /AUTH/i,
];

const SECRET_NAME_PREFIXES =
    /^(AWS|GCP|GOOGLE|AZURE|GITHUB|GITLAB|NPM|YARN|PNPM|BUN|DOCKER|SSH|GPG|STRIPE|TWILIO|SENTRY|VERCEL|NETLIFY|CLOUDFLARE|HEROKU|DATABASE|DB|REDIS|POSTGRES|MYSQL|MONGO)_/;

const SECRET_NAME_EXACT: ReadonlySet<string> = new Set([
    'NODE_AUTH_TOKEN',
    'CI_JOB_TOKEN',
    'HOMEBREW_GITHUB_API_TOKEN',
]);

export function isSecretEnvName(name: string): boolean {
    if (SECRET_NAME_EXACT.has(name)) return true;
    if (SECRET_NAME_PREFIXES.test(name)) return true;
    return SECRET_NAME_SUBSTRINGS.some((r) => r.test(name));
}

export function detectSecretEnvs(env: NodeJS.ProcessEnv = process.env): string[] {
    return Object.keys(env).filter(isSecretEnvName);
}
