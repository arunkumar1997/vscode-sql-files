import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import { createEngine, EngineHarness } from "../helpers/duckdbHarness";
import { TableEntry } from "../../src/types";

const FIXTURES = path.resolve(__dirname, "../fixtures");

describe("Engine — CSV / TSV", () => {
  let harness: EngineHarness;

  afterEach(() => {
    harness?.dispose();
  });

  it("registers sales.csv and returns correct row count", async () => {
    harness = await createEngine();
    const entry: TableEntry = {
      name: "sales_csv",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
    };
    await harness.engine.registerTable(entry);
    const result = await harness.engine.executeQuery(
      "SELECT COUNT(*) AS cnt FROM sales_csv",
      100,
    );
    expect(Number(result.rows[0].cnt)).toBe(5);
  });

  it("registers sales.tsv and computes correct SUM(amount)", async () => {
    harness = await createEngine();
    const entry: TableEntry = {
      name: "sales_tsv",
      filePath: path.join(FIXTURES, "sales.tsv"),
      fileType: "csv",
      isS3: false,
    };
    await harness.engine.registerTable(entry);
    const result = await harness.engine.executeQuery(
      "SELECT SUM(amount) AS total FROM sales_tsv",
      100,
    );
    expect(Number(result.rows[0].total)).toBeCloseTo(927.0, 1);
  });

  it("introspects column schema for sales.csv", async () => {
    harness = await createEngine();
    const entry: TableEntry = {
      name: "sales_schema",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
    };
    const cols = await harness.engine.registerTable(entry);
    const names = cols.map((c) => c.name);
    expect(names).toEqual(["id", "region", "amount", "ts"]);
    expect(cols.length).toBe(4);
  });
});
