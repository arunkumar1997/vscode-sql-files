import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import { createEngine, EngineHarness } from "../helpers/duckdbHarness";
import { TableEntry } from "../../src/types";

const FIXTURES = path.resolve(__dirname, "../fixtures");

describe("Engine — Folder glob", () => {
  let harness: EngineHarness;

  afterEach(() => {
    harness?.dispose();
  });

  it("registers folder-a/*.csv and returns 6 rows total", async () => {
    harness = await createEngine();
    const entry: TableEntry = {
      name: "folder_a",
      filePath: path.join(FIXTURES, "folder-a", "*.csv"),
      fileType: "csv",
      isS3: false,
    };
    await harness.engine.registerTable(entry);
    const result = await harness.engine.executeQuery(
      "SELECT COUNT(*) AS cnt FROM folder_a",
      100,
    );
    expect(Number(result.rows[0].cnt)).toBe(6);
  });
});
