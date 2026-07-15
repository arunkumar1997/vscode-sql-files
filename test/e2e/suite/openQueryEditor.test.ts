import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import type { TestApi } from "../../../src/extension";

suite("openQueryEditor", () => {
  let api: TestApi;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("arunkumar1997.file-sql")!;
    api = (await ext.activate()) as TestApi;
    assert.ok(api, "Test API not returned");

    // The query editor requires at least one table to be loaded
    const registry = api.getRegistry()!;
    const engine = api.getEngine()!;
    const csvPath = path.resolve(
      __dirname,
      "../../../../test/fixtures/sales.csv",
    );
    const entry = {
      name: "sales_qe",
      filePath: csvPath,
      fileType: "csv" as const,
      isS3: false,
      hivePartitioning: false,
    };
    const cols = await engine.registerTable(entry as any);
    (entry as any).columns = cols;
    registry.add(entry as any);
  });

  suiteTeardown(async () => {
    // Close all editors and clean up
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const registry = api.getRegistry();
    const engine = api.getEngine();
    if (registry && engine) {
      for (const e of registry.getAll()) {
        try {
          await engine.dropTable(e.name);
        } catch {}
      }
      registry.clear();
    }
  });

  test("opens a webview panel", async () => {
    await vscode.commands.executeCommand("fileSql.openQueryEditor");

    // Give the webview a moment to appear
    await new Promise((r) => setTimeout(r, 2000));

    // Check that a webview tab with the expected title exists
    const allTabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    const queryTab = allTabs.find((tab) => {
      // WebviewPanel tabs have an input of type TabInputWebview
      if (tab.input && (tab.input as any).viewType === "fileSqlEditor") {
        return true;
      }
      // Fallback: check label
      return tab.label.includes("File SQL");
    });

    assert.ok(queryTab, "Expected a 'File SQL' webview tab to be open");
  });
});
