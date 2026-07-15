import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import { createEngine, EngineHarness } from "../helpers/duckdbHarness";
import { TableEntry } from "../../src/types";

const FIXTURES = path.resolve(__dirname, "../fixtures");

describe("Engine — Parquet", () => {
  let harness: EngineHarness;

  afterEach(() => {
    harness?.dispose();
  });

  it("registers metrics.parquet, queries rows, and verifies schema", async () => {
    harness = await createEngine();
    const entry: TableEntry = {
      name: "metrics",
      filePath: path.join(FIXTURES, "metrics.parquet"),
      fileType: "parquet",
      isS3: false,
    };
    const cols = await harness.engine.registerTable(entry);
    const colNames = cols.map((c) => c.name);
    expect(colNames).toEqual(["id", "metric", "value", "ts"]);

    const result = await harness.engine.executeQuery(
      "SELECT COUNT(*) AS cnt FROM metrics",
      100,
    );
    expect(Number(result.rows[0].cnt)).toBe(5);
  });
});
