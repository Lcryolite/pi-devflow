import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { normalizeTitle } from "../src/domain/text.js";
import { resolveDevflowProjectRoot } from "../src/store/project-root.js";

test("resolveDevflowProjectRoot walks up to the nearest git root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-devflow-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".git"));
  const nested = join(root, "packages", "app");
  await mkdir(nested, { recursive: true });

  const canonicalRoot = await realpath(root);
  assert.equal(await resolveDevflowProjectRoot(nested), canonicalRoot);
  assert.equal(await resolveDevflowProjectRoot(root), canonicalRoot);
});

test("resolveDevflowProjectRoot keeps cwd when no git root exists", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-devflow-nogit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nested = join(root, "work");
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, "note.txt"), "x");

  assert.equal(await resolveDevflowProjectRoot(nested), await realpath(nested));
});

test("normalizeTitle collapses markdown heading glue into one line", () => {
  assert.equal(
    normalizeTitle("接着后续开发### Phase 2：TUI 与恢复"),
    "接着后续开发 · Phase 2：TUI 与恢复",
  );
  assert.equal(normalizeTitle("line1\nline2"), "line1 line2");
});

test("normalizeTitle preserves legitimate # characters", () => {
  assert.equal(normalizeTitle("Fix C# interop for issue #42"), "Fix C# interop for issue #42");
  assert.equal(normalizeTitle("refactor #7: cache"), "refactor #7: cache");
  assert.equal(normalizeTitle("### Phase 2"), "Phase 2");
});
