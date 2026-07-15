import { describe, it, expect, afterEach, vi } from "vitest";
import path from "path";
import { createEngine, EngineHarness } from "../helpers/duckdbHarness";
import { TableRegistry } from "../../src/tableRegistry";
import { clearTables, renameTable } from "../../src/commands/clearTables";
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

describe("Command — renameTable", () => {
  let harness: EngineHarness;

  afterEach(() => {
    harness?.dispose();
    vi.restoreAllMocks();
  });

  it("shows error message when renaming to an existing table name", async () => {
    harness = await createEngine();
    const registry = new TableRegistry();

    const entryA: TableEntry = {
      name: "a",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
    };
    const entryB: TableEntry = {
      name: "b",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
    };
    await harness.engine.registerTable(entryA);
    registry.add(entryA);
    await harness.engine.registerTable(entryB);
    registry.add(entryB);

    // Mock showInputBox to return "b" (bypass the UI validator)
    (window.showInputBox as ReturnType<typeof vi.fn>).mockResolvedValueOnce("b");

    await renameTable("a", registry, harness.engine);

    // Error should be surfaced
    expect(window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("already exists"),
    );

    // Both tables must still exist with original paths
    expect(registry.has("a")).toBe(true);
    expect(registry.has("b")).toBe(true);
    expect(registry.get("a")!.filePath).toBe(entryA.filePath);
    expect(registry.get("b")!.filePath).toBe(entryB.filePath);
  });

  it("rolls back registry rename when engine.renameTable fails", async () => {
    harness = await createEngine();
    const registry = new TableRegistry();

    const entry: TableEntry = {
      name: "a",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
    };
    await harness.engine.registerTable(entry);
    registry.add(entry);

    // Mock showInputBox to return "b" (a name that doesn't exist yet — no collision)
    (window.showInputBox as ReturnType<typeof vi.fn>).mockResolvedValueOnce("b");

    // Force engine.renameTable to fail AFTER registry.rename succeeds
    vi.spyOn(harness.engine, "renameTable").mockRejectedValueOnce(
      new Error("DuckDB engine broke"),
    );

    await renameTable("a", registry, harness.engine);

    // Registry must be rolled back: "a" restored, "b" removed
    expect(registry.has("a")).toBe(true);
    expect(registry.has("b")).toBe(false);
    expect(registry.get("a")!.filePath).toBe(entry.filePath);
    expect(registry.get("a")!.name).toBe("a");

    // Error message surfaced to user
    expect(window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("DuckDB engine broke"),
    );
  });

  it("rename to same name is a no-op (command returns early)", async () => {
    harness = await createEngine();
    const registry = new TableRegistry();

    const entry: TableEntry = {
      name: "a",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
    };
    await harness.engine.registerTable(entry);
    registry.add(entry);

    // Mock showInputBox to return same name "a"
    (window.showInputBox as ReturnType<typeof vi.fn>).mockResolvedValueOnce("a");

    const renameSpy = vi.spyOn(harness.engine, "renameTable");
    await renameTable("a", registry, harness.engine);

    // engine.renameTable should NOT have been called
    expect(renameSpy).not.toHaveBeenCalled();
    // Entry unchanged
    expect(registry.get("a")!.filePath).toBe(entry.filePath);
  });
});
