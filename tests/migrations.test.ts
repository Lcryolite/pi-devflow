import assert from "node:assert/strict";
import test from "node:test";

import { createProjectState, migrateProjectState } from "../src/index.js";

test("schema v1 state migrates deterministically to v2", () => {
  const modern = createProjectState("/repo", "2026-07-30T00:00:00.000Z");
  const legacy = {
    ...modern,
    schemaVersion: 1,
    scheduler: { paused: false, grill: {} },
  } as unknown as Record<string, unknown>;
  delete legacy.evidence;
  delete legacy.appliedProposalIds;
  delete legacy.migrations;

  const migrated = migrateProjectState(legacy, "2026-07-30T00:00:01.000Z");
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.scheduler.maxConcurrentMain, 1);
  assert.ok(migrated.migrations["schema-v1-to-v2"]);
});
