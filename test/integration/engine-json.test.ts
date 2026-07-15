import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import { createEngine, EngineHarness } from "../helpers/duckdbHarness";
import { TableEntry } from "../../src/types";

const FIXTURES = path.resolve(__dirname, "../fixtures");

describe("Engine — JSON / JSONL", () => {
  let harness: EngineHarness;

  afterEach(() => {
    harness?.dispose();
  });

  it("registers events.jsonl and returns 5 rows", async () => {
    harness = await createEngine();
    const entry: TableEntry = {
      name: "events",
      filePath: path.join(FIXTURES, "events.jsonl"),
      fileType: "json",
      isS3: false,
    };
    await harness.engine.registerTable(entry);
    const result = await harness.engine.executeQuery(
      "SELECT COUNT(*) AS cnt FROM events",
      100,
    );
    expect(Number(result.rows[0].cnt)).toBe(5);
  });

  it("registers nested.json and queries a scalar", async () => {
    harness = await createEngine();
    const entry: TableEntry = {
      name: "nested",
      filePath: path.join(FIXTURES, "nested.json"),
      fileType: "json",
      isS3: false,
    };
    await harness.engine.registerTable(entry);
    const result = await harness.engine.executeQuery(
      "SELECT COUNT(*) AS cnt FROM nested",
      100,
    );
    expect(Number(result.rows[0].cnt)).toBe(3);
  });
});
