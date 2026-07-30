import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("Pi manifest points to existing extension and skill resources", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
    keywords: string[];
    pi: { extensions: string[]; skills: string[] };
  };

  assert.ok(manifest.keywords.includes("pi-package"));
  await Promise.all(manifest.pi.extensions.map((path) => access(resolve(root, path))));
  await Promise.all(manifest.pi.skills.map((path) => access(resolve(root, path))));
  await access(resolve(root, "skills/devflow/SKILL.md"));
});
