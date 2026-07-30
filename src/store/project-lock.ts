import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface LockOwner {
  token: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface ProjectLockOptions {
  timeoutMs?: number;
  leaseMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Lock acquisition aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Lock acquisition aborted"));
    }, { once: true });
  });
}

export class ProjectLock {
  private constructor(readonly path: string, private readonly owner: LockOwner) {}

  static async acquire(path: string, options: ProjectLockOptions = {}): Promise<ProjectLock> {
    const timeoutMs = options.timeoutMs ?? 5_000;
    const leaseMs = options.leaseMs ?? 30_000;
    const pollMs = options.pollMs ?? 20;
    const deadline = Date.now() + timeoutMs;
    await mkdir(dirname(path), { recursive: true });

    while (true) {
      const now = new Date();
      const owner: LockOwner = {
        token: randomUUID(),
        pid: process.pid,
        hostname: hostname(),
        acquiredAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + leaseMs).toISOString(),
      };
      try {
        await mkdir(path);
        await writeFile(join(path, "owner.json"), `${JSON.stringify(owner)}\n`, { encoding: "utf8", mode: 0o600 });
        return new ProjectLock(path, owner);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      await ProjectLock.reclaimIfStale(path);
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring project lock: ${path}`);
      await sleep(pollMs, options.signal);
    }
  }

  private static async reclaimIfStale(path: string): Promise<void> {
    let owner: LockOwner;
    try {
      owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as LockOwner;
    } catch {
      try {
        const info = await stat(path);
        if (Date.now() - info.mtimeMs < 1_000) return;
        const quarantine = `${path}.stale.${randomUUID()}`;
        await rename(path, quarantine);
        await rm(quarantine, { recursive: true, force: true });
      } catch (error) {
        if (!(error instanceof SyntaxError) && !(["ENOENT", "EEXIST"] as Array<string | undefined>).includes((error as NodeJS.ErrnoException).code)) throw error;
      }
      return;
    }
    if (Date.parse(owner.expiresAt) > Date.now()) return;
    if (owner.hostname === hostname() && processIsAlive(owner.pid)) return;

    const quarantine = `${path}.stale.${randomUUID()}`;
    try {
      await rename(path, quarantine);
      await rm(quarantine, { recursive: true, force: true });
    } catch (error) {
      if (!(["ENOENT", "EEXIST"] as Array<string | undefined>).includes((error as NodeJS.ErrnoException).code)) throw error;
    }
  }

  async release(): Promise<void> {
    try {
      const current = JSON.parse(await readFile(join(this.path, "owner.json"), "utf8")) as LockOwner;
      if (current.token !== this.owner.token) return;
      await rm(this.path, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
