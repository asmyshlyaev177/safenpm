import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(dir, "..");
const projectRoot = process.env.INIT_CWD || process.env.npm_config_local_prefix || process.cwd();
const installer = resolve(root, "install.sh");
const initScript = resolve(root, "scripts", "init.cjs");
const dist = resolve(root, "dist", "ringfence.mjs");

if (!existsSync(dist)) {
  process.exit(0);
}

if (existsSync(installer)) {
  try {
    execSync(`"${installer}"`, { stdio: "inherit", cwd: root });
  } catch {
    // non-fatal — user can run npx ringfence-setup manually
  }
}

if (existsSync(initScript)) {
  try {
    execSync(`"${process.execPath}" "${initScript}"`, { stdio: "inherit", cwd: projectRoot });
  } catch {
    // non-fatal — user can run npx ringfence-init manually
  }
}
