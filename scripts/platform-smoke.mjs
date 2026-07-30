import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    if (result.error) process.stderr.write(`${result.error.stack ?? result.error.message}\n`);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

function runNpm(args) {
  const npmCli = process.env.npm_execpath;
  return npmCli ? run(process.execPath, [npmCli, ...args]) : run(process.platform === "win32" ? "npm.cmd" : "npm", args);
}

const major = Number(process.versions.node.split(".")[0]);
if (major < 24) throw new Error(`Node 24+ is required; found ${process.version}`);

runNpm(["run", "typecheck"]);
run(process.execPath, ["--import", "tsx", "--test", "tests/**/*.test.ts"]);
const packed = JSON.parse(runNpm(["pack", "--dry-run", "--json"]));
const files = new Set(packed[0]?.files?.map((entry) => entry.path));
for (const required of ["package.json", "README.md", "src/extension.ts", "skills/devflow/SKILL.md"]) {
  if (!files.has(required)) throw new Error(`Packed artifact is missing ${required}`);
}
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (manifest.pi?.extensions?.[0] !== "./src/extension.ts") throw new Error("Pi extension manifest is invalid");
console.log(`platform smoke passed: ${process.platform} ${process.arch}, Node ${process.version}`);
