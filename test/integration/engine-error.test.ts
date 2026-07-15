import { describe, it, expect, afterEach } from "vitest";
import { createEngine, EngineHarness } from "../helpers/duckdbHarness";

describe("Engine — SQL error handling", () => {
  let harness: EngineHarness;

  afterEach(() => {
    harness?.dispose();
  });

  it("throws on invalid SQL", async () => {
    harness = await createEngine();
    await expect(
      harness.engine.executeQuery("SELECT * FROM nonexistent_table_xyz", 100),
    ).rejects.toThrow();
  });
});
