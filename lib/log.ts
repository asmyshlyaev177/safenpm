const PREFIX = '\x1b[1;34m[ringfence]\x1b[0m';
const WARN_PREFIX = '\x1b[1;33m[ringfence]\x1b[0m';
const ERR_PREFIX = '\x1b[1;31m[ringfence]\x1b[0m';

export function info(msg: string): void {
    process.stderr.write(`${PREFIX} ${msg}\n`);
}

export function warn(msg: string): void {
    process.stderr.write(`${WARN_PREFIX} ${msg}\n`);
}

export function err(msg: string): void {
    process.stderr.write(`${ERR_PREFIX} ${msg}\n`);
}
