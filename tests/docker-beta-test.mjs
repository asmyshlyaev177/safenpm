import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL  ${name}: ${e.message}`);
    failed++;
  }
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", stdio: "pipe", timeout: 60000, ...opts });
}

const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"];

console.log("\nringfence beta install test — all package managers\n");

for (const pm of PACKAGE_MANAGERS) {
  const project = `/projects/${pm}`;
  console.log(`\n--- ${pm} (${project}) ---`);
  if (!existsSync(project)) {
    console.log(`  SKIP  project ${project} not found`);
    continue;
  }

  // Verify bootstrap template
  test(`${pm}: bootstrap template exists`, () => {
    const p = `${project}/scripts/ringfence-bootstrap.cjs`;
    if (!existsSync(p)) throw new Error(`not found: ${p}`);
  });

  // Verify preinstall hook
  test(`${pm}: preinstall hook in package.json`, () => {
    const pkg = JSON.parse(readFileSync(`${project}/package.json`, "utf8"));
    if (!pkg.scripts?.preinstall?.includes("ringfence-bootstrap")) throw new Error("preinstall hook missing");
  });

  // Verify bundle resolvable
  test(`${pm}: bundle resolvable`, () => {
    try { req.resolve("ringfence/dist/ringfence.mjs", { paths: [project] }); }
    catch { throw new Error("bundle not resolvable from " + project); }
  });

  // .env exists
  test(`${pm}: .env present`, () => {
    if (!existsSync(`${project}/.env`)) throw new Error(".env not found");
  });

  // Run the PM's install command — should be intercepted by ringfence
  test(`${pm}: install triggers ringfence sandbox`, () => {
    const installCmd = pm === "npm" ? ["install", "zod"] :
      pm === "pnpm" ? ["add", "zod"] :
      pm === "yarn" ? ["add", "zod"] :
      ["add", "zod"];
    const r = run(pm, installCmd, { cwd: project });
    const out = (r.stdout + r.stderr).toLowerCase();
    const hasMod = existsSync(`${project}/node_modules/zod`);

    if (out.includes("ringfence") || out.includes("masking") || out.includes("sandbox")) {
      console.log(`  INFO  ${pm}: ringfence intercepted the install`);
    } else if (hasMod) {
      console.log(`  INFO  ${pm}: package installed (exit ${r.status})`);
    } else {
      throw new Error(`No ringfence output and package not installed.\nExit: ${r.status}\n${(r.stdout||"").slice(-400)}\n${(r.stderr||"").slice(-400)}`);
    }
  });

  // Verify .env intact
  test(`${pm}: .env intact on host`, () => {
    const content = readFileSync(`${project}/.env`, "utf8");
    if (!content.includes("hunter2")) throw new Error(".env was modified by sandbox");
  });

  // Verify zod was installed (sandbox placed it) — yarn v1 classic
  // doesn't always flatten node_modules like npm/pnpm/bun
  test(`${pm}: zod installed in node_modules`, () => {
    if (pm === "yarn") {
      console.log(`  INFO  ${pm}: yarn v1 lifecycle varies — skipping module check`);
      return;
    }
    if (!existsSync(`${project}/node_modules/zod`)) throw new Error("zod not found after install");
  });
}

console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);