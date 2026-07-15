import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import type { TestApi } from "../../../src/extension";

/** Poll a condition up to `timeoutMs`, resolving on first truthy result. */
async function poll<T>(
  fn: () => T | Promise<T>,
  timeoutMs = 10_000,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) {
      return result;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("poll timed out");
}

suite("addPath", () => {
  let api: TestApi;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("arunkumar1997.file-sql")!;
    api = (await ext.activate()) as TestApi;
    assert.ok(api, "Test API not returned — is extensionMode === Test?");
  });

  suiteTeardown(async () => {
    const registry = api.getRegistry();
    const engine = api.getEngine();
    if (registry && engine) {
      for (const entry of registry.getAll()) {
        try {
          await engine.dropTable(entry.name);
        } catch { }
      }
      registry.clear();
    }
  });

  test("registers a CSV file and it appears in the registry", async () => {
    const registry = api.getRegistry()!;
    const engine = api.getEngine()!;

    // Ensure engine is initialized (lazy init since activation no longer blocks on init)
    await engine.ensureInitialized();

    const fixturesDir = path.resolve(__dirname, "../../../../test/fixtures");
    const csvPath = path.join(fixturesDir, "sales.csv");

    const entry = {
      name: "sales",
      filePath: csvPath,
      fileType: "csv" as const,
      isS3: false,
      hivePartitioning: false,
    };

    const cols = await engine.registerTable(entry as any);
    (entry as any).columns = cols;
    registry.add(entry as any);

    const found = await poll(() =>
      registry.getAll().find((e: any) => e.name === "sales"),
    );
    assert.ok(found, "Table 'sales' should appear in the registry");
    assert.ok(
      found.columns && found.columns.length > 0,
      "Table should have columns after introspection",
    );
  });
});
