import { describe, it, expect, afterEach, vi } from "vitest";
import path from "path";
import { createEngine, EngineHarness } from "../helpers/duckdbHarness";
import { TableRegistry } from "../../src/tableRegistry";
import { addFolder } from "../../src/commands/addFolder";
import { window, Uri } from "../helpers/vscode-mock";

const FIXTURES = path.resolve(__dirname, "../fixtures");

describe("Command — addFolder", () => {
  let harness: EngineHarness;

  afterEach(() => {
    harness?.dispose();
    vi.restoreAllMocks();
  });

  it("registers all CSVs in folder-a and makes them queryable", async () => {
    harness = await createEngine();
    const registry = new TableRegistry();
    const folderPath = path.join(FIXTURES, "folder-a");

    // Mock showOpenDialog to return the folder
    (window.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      Uri.file(folderPath),
    ]);

    await addFolder(registry, harness.engine);

    // scanFolder groups folder-a into one table
    const tables = registry.getAll();
    expect(tables.length).toBeGreaterThanOrEqual(1);

    // The glob table should contain all 6 rows from both part files
    const tableName = tables[0].name;
    const result = await harness.engine.executeQuery(
      `SELECT COUNT(*) AS cnt FROM "${tableName}"`,
      100,
    );
    expect(Number(result.rows[0].cnt)).toBe(6);
  });
});
