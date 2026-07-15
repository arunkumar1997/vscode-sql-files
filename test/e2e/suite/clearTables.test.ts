import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import type { TestApi } from "../../../src/extension";

suite("clearTables", () => {
  let api: TestApi;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("arunkumar1997.file-sql")!;
    api = (await ext.activate()) as TestApi;
    assert.ok(api, "Test API not returned");
  });

  test("clears all registered tables", async () => {
    const registry = api.getRegistry()!;
    const engine = api.getEngine()!;

    const fixturesDir = path.resolve(
      __dirname,
      "../../../../test/fixtures",
    );

    // Load two tables
    const entry1 = {
      name: "clear_test_1",
      filePath: path.join(fixturesDir, "sales.csv"),
      fileType: "csv" as const,
      isS3: false,
      hivePartitioning: false,
    };
    const cols1 = await engine.registerTable(entry1 as any);
    (entry1 as any).columns = cols1;
    registry.add(entry1 as any);

    const entry2 = {
      name: "clear_test_2",
      filePath: path.join(fixturesDir, "sales.csv"),
      fileType: "csv" as const,
      isS3: false,
      hivePartitioning: false,
    };
    const cols2 = await engine.registerTable(entry2 as any);
    (entry2 as any).columns = cols2;
    registry.add(entry2 as any);

    assert.ok(
      registry.getAll().length >= 2,
      "Should have at least 2 tables loaded",
    );

    // clearTables command shows a modal warning — monkey-patch to auto-confirm
    const original = vscode.window.showWarningMessage;
    (vscode.window as any).showWarningMessage = async (...args: any[]) => {
      // Return the affirmative button text
      return "Yes";
    };

    try {
      await vscode.commands.executeCommand("fileSql.clearTables");
      // Give the command a moment to process
      await new Promise((r) => setTimeout(r, 1000));
    } finally {
      (vscode.window as any).showWarningMessage = original;
    }

    assert.strictEqual(
      registry.getAll().length,
      0,
      "Registry should be empty after clearTables",
    );
  });
});
