import { open, readFile } from "node:fs/promises";

import { validateProject } from "../domain/invariants.js";
import { migrateProjectState } from "../domain/migrations.js";
import type { ProjectState } from "../domain/types.js";

export interface ProjectEvent {
  eventId: string;
  revision: number;
  timestamp: string;
  actor: string;
  state: ProjectState;
}

export async function appendProjectEvent(path: string, event: ProjectEvent): Promise<void> {
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readLatestJournalState(path: string): Promise<ProjectState | undefined> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  const lines = contents.split("\n");
  let latest: ProjectState | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    try {
      const event = JSON.parse(line) as ProjectEvent;
      const state = migrateProjectState(event.state, event.timestamp);
      if (!event.state || event.revision !== state.revision) throw new Error("Journal revision mismatch");
      validateProject(state);
      if (!latest || state.revision > latest.revision) latest = state;
    } catch (error) {
      const isLastNonEmpty = lines.slice(index + 1).every((remaining) => !remaining.trim());
      if (!isLastNonEmpty) throw new Error(`Invalid journal entry at line ${index + 1}`, { cause: error });
    }
  }
  return latest ? structuredClone(latest) : undefined;
}
