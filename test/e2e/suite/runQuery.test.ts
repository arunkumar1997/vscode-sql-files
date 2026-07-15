import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import type { TestApi } from "../../../src/extension";

suite("runQuery", () => {
  let api: TestApi;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("arunkumar1997.file-sql")!;
    api = (await ext.activate()) as TestApi;
    assert.ok(api, "Test API not returned");

    const registry = api.getRegistry()!;
    const engine = api.getEngine()!;
    const csvPath = path.resolve(
      __dirname,
      "../../../../test/fixtures/sales.csv",
    );
    const entry = {
      name: "sales_rq",
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

  test("SELECT COUNT(*) returns expected row count", async () => {
    const engine = api.getEngine()!;
    const result = await engine.executeQuery(
      "SELECT COUNT(*) AS cnt FROM sales_rq",
      100,
    );

    assert.ok(result, "Query should return a result");
    assert.ok(result.rows.length === 1, "Should return exactly 1 row");

    // DuckDB count(*) returns a BigInt that gets serialized to a number
    const count = result.rows[0].cnt;
    assert.strictEqual(count, 5, "sales.csv has 5 data rows");
  });

  test("SELECT with WHERE filters correctly", async () => {
    const engine = api.getEngine()!;
    const result = await engine.executeQuery(
      "SELECT * FROM sales_rq WHERE region = 'north'",
      100,
    );

    assert.ok(result, "Query should return a result");
    assert.strictEqual(
      result.rows.length,
      2,
      "Two rows have region = 'north'",
    );
  });
});
