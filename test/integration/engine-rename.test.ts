import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import { createEngine, EngineHarness } from "../helpers/duckdbHarness";
import { TableRegistry } from "../../src/tableRegistry";
import { TableEntry } from "../../src/types";

const FIXTURES = path.resolve(__dirname, "../fixtures");

describe("Engine — Rename table", () => {
  let harness: EngineHarness;

  afterEach(() => {
    harness?.dispose();
  });

  it("renames a table: new name queryable, old name errors", async () => {
    harness = await createEngine();
    const registry = new TableRegistry();

    const entry: TableEntry = {
      name: "sales",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
    };
    await harness.engine.registerTable(entry);
    registry.add(entry);

    // Query with old name works
    const before = await harness.engine.executeQuery(
      "SELECT COUNT(*) AS cnt FROM sales",
      100,
    );
    expect(Number(before.rows[0].cnt)).toBe(5);

    // Rename
    registry.rename("sales", "revenue");
    const renamed = registry.get("revenue")!;
    await harness.engine.renameTable("sales", renamed);

    // Query with new name works
    const after = await harness.engine.executeQuery(
      "SELECT COUNT(*) AS cnt FROM revenue",
      100,
    );
    expect(Number(after.rows[0].cnt)).toBe(5);

    // Query with old name throws
    await expect(
      harness.engine.executeQuery("SELECT * FROM sales", 100),
    ).rejects.toThrow();
  });
});
