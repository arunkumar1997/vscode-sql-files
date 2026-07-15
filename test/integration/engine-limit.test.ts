import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import { createEngine, EngineHarness } from "../helpers/duckdbHarness";
import { TableEntry } from "../../src/types";

const FIXTURES = path.resolve(__dirname, "../fixtures");

describe("Engine — maxRows truncation", () => {
  let harness: EngineHarness;

  afterEach(() => {
    harness?.dispose();
  });

  it("truncates result when rows exceed maxRows", async () => {
    harness = await createEngine();
    const entry: TableEntry = {
      name: "sales_limit",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
    };
    await harness.engine.registerTable(entry);

    const result = await harness.engine.executeQuery(
      "SELECT * FROM sales_limit",
      3,
    );
    expect(result.truncated).toBe(true);
    expect(result.rows.length).toBe(3);
  });
});
