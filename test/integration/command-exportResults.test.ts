import { describe, it, expect, afterEach, vi } from "vitest";
import path from "path";
import fs from "fs";
import { createEngine, EngineHarness } from "../helpers/duckdbHarness";
import { createTempDir, TempDir } from "../helpers/tempDir";
import { TableRegistry } from "../../src/tableRegistry";
import { openQueryEditor } from "../../src/commands/openQueryEditor";
import { window, Uri } from "../helpers/vscode-mock";
import { TableEntry } from "../../src/types";

const FIXTURES = path.resolve(__dirname, "../fixtures");

describe("Command — exportResults", () => {
  let harness: EngineHarness;
  let disposeHandler: (() => void) | undefined;
  let tmp: TempDir;

  function buildMockPanel() {
    let messageHandler: ((msg: unknown) => Promise<void>) | undefined;
    const postedMessages: unknown[] = [];
    const mockPanel = {
      webview: {
        postMessage: vi.fn((msg: unknown) => {
          postedMessages.push(msg);
          return Promise.resolve(true);
        }),
        onDidReceiveMessage: vi.fn(
          (handler: (msg: unknown) => Promise<void>) => {
            messageHandler = handler;
            return { dispose: vi.fn() };
          },
        ),
        asWebviewUri: vi.fn((uri: unknown) => uri),
        cspSource: "test",
        html: "",
      },
      reveal: vi.fn(),
      onDidDispose: vi.fn((handler: () => void) => {
        disposeHandler = handler;
        return { dispose: vi.fn() };
      }),
      dispose: vi.fn(),
    };
    return { mockPanel, postedMessages, getHandler: () => messageHandler };
  }

  async function setupWithTable() {
    harness = await createEngine();
    const registry = new TableRegistry();
    const entry: TableEntry = {
      name: "sales",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
    };
    const cols = await harness.engine.registerTable(entry);
    entry.columns = cols;
    registry.add(entry);
    return registry;
  }

  function openEditor(registry: TableRegistry, mockPanel: ReturnType<typeof buildMockPanel>["mockPanel"]) {
    (window.createWebviewPanel as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockPanel);
    const context = {
      extensionUri: Uri.file("/fake/extension"),
      subscriptions: [] as { dispose: () => void }[],
    };
    openQueryEditor(context as never, registry, harness.engine);
  }

  afterEach(() => {
    disposeHandler?.();
    harness?.dispose();
    tmp?.cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("exportResults opens showSaveDialog with CSV filters and invokes engine.exportQuery", async () => {
    const registry = await setupWithTable();
    const { mockPanel, postedMessages, getHandler } = buildMockPanel();
    openEditor(registry, mockPanel);

    tmp = createTempDir();
    const savePath = path.join(tmp.path, "export.csv");
    (window.showSaveDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      Uri.file(savePath),
    );

    // First run a query to populate the tab
    const handler = getHandler()!;
    await handler({
      type: "runQuery",
      payload: { sql: "SELECT * FROM sales", tabId: "tab1" },
    });

    // Now request export
    await handler({
      type: "exportResults",
      payload: { tabId: "tab1", format: "csv" },
    });

    // showSaveDialog called with CSV filter
    expect(window.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({ "CSV Files": ["csv"] }),
        defaultUri: expect.objectContaining({ fsPath: expect.stringContaining(".csv") }),
      }),
    );

    // exportResult posted with the original SQL (not the capped visible rows)
    const exportResult = postedMessages.find(
      (m: any) => m.type === "exportResult",
    ) as any;
    expect(exportResult).toBeDefined();
    expect(exportResult.tabId).toBe("tab1");
    expect(exportResult.payload.path).toBe(savePath);
    expect(exportResult.payload.format).toBe("csv");

    // Verify the file was actually written with full data
    expect(fs.existsSync(savePath)).toBe(true);
    const lines = fs.readFileSync(savePath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(6); // header + 5 rows
  });

  it("exportResults opens showSaveDialog with Parquet filters", async () => {
    const registry = await setupWithTable();
    const { mockPanel, postedMessages, getHandler } = buildMockPanel();
    openEditor(registry, mockPanel);

    tmp = createTempDir();
    const savePath = path.join(tmp.path, "export.parquet");
    (window.showSaveDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      Uri.file(savePath),
    );

    const handler = getHandler()!;
    await handler({
      type: "runQuery",
      payload: { sql: "SELECT * FROM sales", tabId: "tab1" },
    });

    await handler({
      type: "exportResults",
      payload: { tabId: "tab1", format: "parquet" },
    });

    expect(window.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({ "Parquet Files": ["parquet"] }),
        defaultUri: expect.objectContaining({ fsPath: expect.stringContaining(".parquet") }),
      }),
    );

    const exportResult = postedMessages.find(
      (m: any) => m.type === "exportResult",
    ) as any;
    expect(exportResult).toBeDefined();
    expect(exportResult.payload.format).toBe("parquet");

    // Verify the parquet file exists
    expect(fs.existsSync(savePath)).toBe(true);
  });

  it("cancellation (no file selected) performs no export and posts no error", async () => {
    const registry = await setupWithTable();
    const { mockPanel, postedMessages, getHandler } = buildMockPanel();
    openEditor(registry, mockPanel);

    // showSaveDialog returns undefined (user cancelled)
    (window.showSaveDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

    const handler = getHandler()!;
    await handler({
      type: "runQuery",
      payload: { sql: "SELECT * FROM sales", tabId: "tab1" },
    });

    await handler({
      type: "exportResults",
      payload: { tabId: "tab1", format: "csv" },
    });

    // No exportResult or exportError message
    const exportResult = postedMessages.find((m: any) => m.type === "exportResult");
    const exportError = postedMessages.find((m: any) => m.type === "exportError");
    expect(exportResult).toBeUndefined();
    expect(exportError).toBeUndefined();
  });

  it("failure posts exportError with tabId and message", async () => {
    const registry = await setupWithTable();
    const { mockPanel, postedMessages, getHandler } = buildMockPanel();
    openEditor(registry, mockPanel);

    tmp = createTempDir();
    // Point to a non-writable path
    const badPath = path.join(tmp.path, "no-such-dir", "deep", "export.csv");
    (window.showSaveDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      Uri.file(badPath),
    );

    const handler = getHandler()!;
    await handler({
      type: "runQuery",
      payload: { sql: "SELECT * FROM sales", tabId: "tab1" },
    });

    await handler({
      type: "exportResults",
      payload: { tabId: "tab1", format: "csv" },
    });

    const exportError = postedMessages.find(
      (m: any) => m.type === "exportError",
    ) as any;
    expect(exportError).toBeDefined();
    expect(exportError.tabId).toBe("tab1");
    expect(exportError.payload.message).toBeTruthy();
  });

  it("invalid export format is rejected without writing", async () => {
    const registry = await setupWithTable();
    const { mockPanel, postedMessages, getHandler } = buildMockPanel();
    openEditor(registry, mockPanel);

    const handler = getHandler()!;
    await handler({
      type: "runQuery",
      payload: { sql: "SELECT * FROM sales", tabId: "tab1" },
    });

    await handler({
      type: "exportResults",
      payload: { tabId: "tab1", format: "xlsx" },
    });

    // showSaveDialog should NOT have been called
    expect(window.showSaveDialog).not.toHaveBeenCalled();

    // Should post an exportError
    const exportError = postedMessages.find(
      (m: any) => m.type === "exportError",
    ) as any;
    expect(exportError).toBeDefined();
    expect(exportError.payload.message).toMatch(/unsupported.*format/i);
  });

  it("runQuery with a custom COPY statement passes SQL unchanged and posts success", async () => {
    const registry = await setupWithTable();
    const { mockPanel, postedMessages, getHandler } = buildMockPanel();
    openEditor(registry, mockPanel);

    tmp = createTempDir();
    const dest = path.join(tmp.path, "custom-export.csv");

    const handler = getHandler()!;
    // Send a raw COPY statement — Phase 1 engine should handle this
    await handler({
      type: "runQuery",
      payload: {
        sql: `COPY (SELECT * FROM sales ORDER BY id) TO '${dest.replace(/'/g, "''")}' (FORMAT CSV, HEADER)`,
        tabId: "tab1",
      },
    });

    // Should get a queryResult (not an error)
    const result = postedMessages.find(
      (m: any) => m.type === "queryResult",
    ) as any;
    expect(result).toBeDefined();
    expect(result.tabId).toBe("tab1");
    // Non-row statement: empty result
    expect(result.payload.rowCount).toBe(0);
    expect(result.payload.columns).toEqual([]);

    // The file should actually exist with data
    expect(fs.existsSync(dest)).toBe(true);
    const lines = fs.readFileSync(dest, "utf-8").trim().split("\n");
    expect(lines.length).toBe(6); // header + 5 rows
  });

  it("exports the ORIGINAL SQL not the capped visible rows", async () => {
    const registry = await setupWithTable();
    const { mockPanel, postedMessages, getHandler } = buildMockPanel();
    openEditor(registry, mockPanel);

    tmp = createTempDir();
    const savePath = path.join(tmp.path, "full-export.csv");
    (window.showSaveDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      Uri.file(savePath),
    );

    const handler = getHandler()!;
    // Run query — the handler stores the original SQL per tab
    await handler({
      type: "runQuery",
      payload: { sql: "SELECT * FROM sales ORDER BY id", tabId: "tab1" },
    });

    // Export — should use original SQL, not the LIMIT-wrapped version
    await handler({
      type: "exportResults",
      payload: { tabId: "tab1", format: "csv" },
    });

    const exportResult = postedMessages.find(
      (m: any) => m.type === "exportResult",
    ) as any;
    expect(exportResult).toBeDefined();

    // Verify full data (not truncated to maxRows)
    const content = fs.readFileSync(savePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(6); // header + 5 data rows (all of them)
  });
});
