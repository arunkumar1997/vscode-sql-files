import { describe, it, expect, afterEach, vi } from "vitest";
import path from "path";
import { createEngine, EngineHarness } from "../helpers/duckdbHarness";
import { TableRegistry } from "../../src/tableRegistry";
import { clearTables } from "../../src/commands/clearTables";
import { window } from "../helpers/vscode-mock";
import { TableEntry } from "../../src/types";

const FIXTURES = path.resolve(__dirname, "../fixtures");

describe("Command — clearTables", () => {
  let harness: EngineHarness;

  afterEach(() => {
    harness?.dispose();
    vi.restoreAllMocks();
  });

  it("removes all tables from registry and drops DuckDB views", async () => {
    harness = await createEngine();
    const registry = new TableRegistry();

    // Register two tables
    const entry1: TableEntry = {
      name: "t1",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
    };
    const entry2: TableEntry = {
      name: "t2",
      filePath: path.join(FIXTURES, "events.jsonl"),
      fileType: "json",
      isS3: false,
    };
    await harness.engine.registerTable(entry1);
    registry.add(entry1);
    await harness.engine.registerTable(entry2);
    registry.add(entry2);

    expect(registry.getAll()).toHaveLength(2);

    // Mock the confirmation dialog to return "Yes"
    (
      window.showWarningMessage as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce("Yes");

    await clearTables(registry, harness.engine);

    // Registry should be empty
    expect(registry.getAll()).toHaveLength(0);

    // DuckDB views should be gone — querying either name should throw
    await expect(
      harness.engine.executeQuery("SELECT * FROM t1", 100),
    ).rejects.toThrow();
    await expect(
      harness.engine.executeQuery("SELECT * FROM t2", 100),
    ).rejects.toThrow();
  });
});
