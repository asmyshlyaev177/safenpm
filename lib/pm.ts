export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export const PACKAGE_MANAGERS: readonly PackageManager[] = ['npm', 'pnpm', 'yarn', 'bun'];

export function isPackageManager(value: string): value is PackageManager {
    return (PACKAGE_MANAGERS as readonly string[]).includes(value);
}

// Subcommands that fetch and execute third-party code with lifecycle scripts.
// Aliases included. For yarn, '' (no subcommand) defaults to install.
const INSTALL_SUBCOMMANDS: Record<PackageManager, ReadonlySet<string>> = {
    npm: new Set([
        'i',
        'in',
        'ins',
        'inst',
        'insta',
        'instal',
        'install',
        'isntall',
        'add',
        'ci',
        'update',
        'up',
        'upgrade',
        'rebuild',
        'exec',
    ]),
    pnpm: new Set(['i', 'install', 'add', 'update', 'up', 'upgrade', 'rebuild', 'dlx', 'create']),
    yarn: new Set(['', 'install', 'add', 'upgrade', 'up', 'create', 'dlx']),
    bun: new Set(['i', 'install', 'add', 'update', 'upgrade', 'create', 'x']),
};

export function isInstallLike(pm: PackageManager, args: readonly string[]): boolean {
    const sub = args.find((a) => !a.startsWith('-')) ?? '';
    return INSTALL_SUBCOMMANDS[pm].has(sub);
}

// Per-package-manager state directories under $HOME that must be exposed
// into the sandbox: ro = config files (auth tokens), rw = caches.
export function homeStateDirs(pm: PackageManager, home: string): { ro: string[]; rw: string[] } {
    const ro = [`${home}/.npmrc`, `${home}/.yarnrc`, `${home}/.yarnrc.yml`];
    const rw: Record<PackageManager, string[]> = {
        npm: [`${home}/.npm`],
        pnpm: [`${home}/.local/share/pnpm`, `${home}/.config/pnpm`, `${home}/.cache/pnpm`],
        yarn: [`${home}/.yarn`, `${home}/.cache/yarn`, `${home}/.config/yarn`],
        bun: [`${home}/.bun`, `${home}/.cache/bun`],
    };
    return { ro, rw: rw[pm] };
}
