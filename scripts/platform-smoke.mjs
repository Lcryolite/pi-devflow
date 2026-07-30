import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args) {
  const result = spawnSync(command, args, { cwd: new URL("..", import.meta.url), encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

const major = Number(process.versions.node.split(".")[0]);
if (major < 24) throw new Error(`Node 24+ is required; found ${process.version}`);

run(npm, ["run", "typecheck"]);
run(process.execPath, ["--import", "tsx", "--test", "tests/**/*.test.ts"]);
const packed = JSON.parse(run(npm, ["pack", "--dry-run", "--json"]));
const files = new Set(packed[0]?.files?.map((entry) => entry.path));
for (const required of ["package.json", "README.md", "src/extension.ts", "skills/devflow/SKILL.md"]) {
  if (!files.has(required)) throw new Error(`Packed artifact is missing ${required}`);
}
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (manifest.pi?.extensions?.[0] !== "./src/extension.ts") throw new Error("Pi extension manifest is invalid");
console.log(`platform smoke passed: ${process.platform} ${process.arch}, Node ${process.version}`);
