import { describe, it, expect, afterEach, vi } from "vitest";
import path from "path";
import { createEngine, EngineHarness } from "../helpers/duckdbHarness";
import { TableRegistry } from "../../src/tableRegistry";
import { addPath } from "../../src/commands/addPath";
import { window } from "../helpers/vscode-mock";

const FIXTURES = path.resolve(__dirname, "../fixtures");

describe("Command — addPath (local file)", () => {
  let harness: EngineHarness;

  afterEach(() => {
    harness?.dispose();
    vi.restoreAllMocks();
  });

  it("registers a local CSV via Enter Path and makes it queryable", async () => {
    harness = await createEngine();
    const registry = new TableRegistry();
    const csvPath = path.join(FIXTURES, "sales.csv");

    // Mock the QuickPick to select "Enter Path"
    (window.showQuickPick as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "enter",
    });
    // Mock the InputBox to return the fixture path
    (window.showInputBox as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      csvPath,
    );

    await addPath(registry, harness.engine);

    // The table should now be in the registry
    expect(registry.has("sales")).toBe(true);
    const entry = registry.get("sales")!;
    expect(entry.columns).toBeDefined();
    expect(entry.columns!.length).toBeGreaterThan(0);

    // The engine should be able to query it
    const result = await harness.engine.executeQuery(
      "SELECT COUNT(*) AS cnt FROM sales",
      100,
    );
    expect(Number(result.rows[0].cnt)).toBe(5);
  });
});
