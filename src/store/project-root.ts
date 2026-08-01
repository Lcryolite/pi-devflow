import { access, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the durable project root for Devflow state.
 *
 * Prefer the nearest Git worktree/repository root so that multiple Pi sessions
 * in the same repo share one project, and sessions in different repos stay isolated.
 * Bare directories without `.git` keep the resolved cwd (not the home folder by default).
 */
export async function resolveDevflowProjectRoot(cwd: string): Promise<string> {
  let dir = resolve(cwd);
  try {
    dir = await realpath(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let current = dir;
  for (;;) {
    if (await pathExists(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dir;
}
