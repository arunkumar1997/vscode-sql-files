import { describe, it, expect, afterEach, vi } from "vitest";
import path from "path";
import { createEngine, EngineHarness } from "../helpers/duckdbHarness";
import { TableRegistry } from "../../src/tableRegistry";
import { createTableQuery, getWorkspaceQueries, openQueryEditor, requestQueryTabsSnapshot, setWorkspaceQueries } from "../../src/commands/openQueryEditor";
import { window, Uri } from "../helpers/vscode-mock";
import { TableEntry } from "../../src/types";

const FIXTURES = path.resolve(__dirname, "../fixtures");

describe("Command — openQueryEditor", () => {
  let harness: EngineHarness;
  let disposeHandler: (() => void) | undefined;

  afterEach(() => {
    // Reset the module-level panel state by triggering dispose
    disposeHandler?.();
    harness?.dispose();
    vi.restoreAllMocks();
    setWorkspaceQueries([]);
  });

  it("builds a runnable query with a safely quoted table identifier", () => {
    expect(createTableQuery('daily "sales"')).toEqual({
      name: 'daily "sales"',
      sql: 'SELECT *\nFROM "daily ""sales"""',
    });
  });

  it("normalizes duplicate workspace query names without reordering", () => {
    setWorkspaceQueries([
      { name: "Report", sql: "SELECT 1" },
      { name: "report", sql: "SELECT 2" },
    ]);

    expect(getWorkspaceQueries()).toEqual([
      { name: "Report", sql: "SELECT 1" },
      { name: "report (2)", sql: "SELECT 2" },
    ]);
  });

  it("restores saved queries on ready and records later tab changes", async () => {
    harness = await createEngine();
    const registry = new TableRegistry();
    registry.add({
      name: "sales",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
    });
    setWorkspaceQueries([{ name: "totals", sql: "SELECT COUNT(*) FROM sales" }]);

    let messageHandler: ((msg: any) => Promise<void>) | undefined;
    const postedMessages: any[] = [];
    const mockPanel = {
      webview: {
        postMessage: vi.fn((message: unknown) => {
          postedMessages.push(message);
          return Promise.resolve(true);
        }),
        onDidReceiveMessage: vi.fn((handler: (msg: any) => Promise<void>) => {
          messageHandler = handler;
          return { dispose: vi.fn() };
        }),
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
    (window.createWebviewPanel as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockPanel);
    const context = {
      extensionUri: Uri.file("/fake/extension"),
      subscriptions: [] as { dispose: () => void }[],
    };

    openQueryEditor(context as never, registry, harness.engine, "sales");
    await messageHandler!({ type: "ready" });

    expect(postedMessages).toContainEqual({
      type: "savedQueries",
      payload: { queries: [{ name: "totals", sql: "SELECT COUNT(*) FROM sales" }] },
    });
    expect(postedMessages).toContainEqual({
      type: "openTableQuery",
      payload: {
        query: { name: "sales", sql: 'SELECT *\nFROM "sales"' },
      },
    });

    await messageHandler!({
      type: "queryTabsChanged",
      payload: { queries: [{ name: "details", sql: "SELECT * FROM sales" }] },
    });
    expect(getWorkspaceQueries()).toEqual([
      { name: "details", sql: "SELECT * FROM sales" },
    ]);
  });

  it("dispatches runQuery and receives queryResult via postMessage", async () => {
    harness = await createEngine();
    const registry = new TableRegistry();

    // Register a table
    const entry: TableEntry = {
      name: "sales",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
    };
    const cols = await harness.engine.registerTable(entry);
    entry.columns = cols;
    registry.add(entry);

    // Build a mock webview panel that captures posted messages
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

    (
      window.createWebviewPanel as ReturnType<typeof vi.fn>
    ).mockReturnValueOnce(mockPanel);

    // Mock ExtensionContext
    const context = {
      extensionUri: Uri.file("/fake/extension"),
      subscriptions: [] as { dispose: () => void }[],
    };

    openQueryEditor(context as never, registry, harness.engine, { source: "view/title" });

    // The message handler should be registered
    expect(messageHandler).toBeDefined();

    // Simulate the webview sending a runQuery message
    await messageHandler!({
      type: "runQuery",
      payload: { sql: "SELECT COUNT(*) AS cnt FROM sales", tabId: "tab1" },
    });

    // Find the queryResult in posted messages
    const queryResult = postedMessages.find(
      (m: any) => m.type === "queryResult",
    ) as any;
    expect(queryResult).toBeDefined();
    expect(queryResult.tabId).toBe("tab1");
    expect(Number(queryResult.payload.rows[0].cnt)).toBe(5);
    expect(queryResult.payload.truncated).toBe(false);
  });

  it("reports a configured table as not loaded when its query is run", async () => {
    harness = await createEngine();
    const registry = new TableRegistry();
    registry.add({
      name: "sales",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
      loadState: "configured",
    });

    let messageHandler: ((msg: unknown) => Promise<void>) | undefined;
    const postedMessages: any[] = [];
    const mockPanel = {
      webview: {
        postMessage: vi.fn((msg: unknown) => {
          postedMessages.push(msg);
          return Promise.resolve(true);
        }),
        onDidReceiveMessage: vi.fn((handler: (msg: unknown) => Promise<void>) => {
          messageHandler = handler;
          return { dispose: vi.fn() };
        }),
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
    (window.createWebviewPanel as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockPanel);
    const context = {
      extensionUri: Uri.file("/fake/extension"),
      subscriptions: [] as { dispose: () => void }[],
    };

    openQueryEditor(context as never, registry, harness.engine, "sales");
    await messageHandler!({
      type: "runQuery",
      payload: { sql: 'SELECT * FROM "sales"', tabId: "sales-tab" },
    });

    expect(postedMessages).toContainEqual({
      type: "queryError",
      payload: {
        message:
          'Table "sales" is not loaded. Load it from File SQL Tables, then run the query again.',
      },
      tabId: "sales-tab",
    });

    registry.add({
      name: "a",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
      loadState: "configured",
    });
    await messageHandler!({
      type: "runQuery",
      payload: { sql: "SELECT * FROM missing", tabId: "missing-tab" },
    });
    const missingError = postedMessages.find(
      (message) => message.type === "queryError" && message.tabId === "missing-tab",
    );
    expect(missingError.payload.message).toMatch(/missing.*does not exist/is);
    expect(missingError.payload.message).not.toContain('Table "a" is not loaded');
  });

  it.each([
    ["missing payload", { type: "runQuery" }],
    ["null payload", { type: "runQuery", payload: null }],
    ["wrong payload types", { type: "runQuery", payload: { sql: 42, tabId: true } }],
  ])("handles runQuery with %s", async (_case, message) => {
    harness = await createEngine();
    const registry = new TableRegistry();
    registry.add({
      name: "sales",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
    });

    let messageHandler: ((msg: unknown) => Promise<void>) | undefined;
    const postedMessages: any[] = [];
    const mockPanel = {
      webview: {
        postMessage: vi.fn((postedMessage: unknown) => {
          postedMessages.push(postedMessage);
          return Promise.resolve(true);
        }),
        onDidReceiveMessage: vi.fn((handler: (msg: unknown) => Promise<void>) => {
          messageHandler = handler;
          return { dispose: vi.fn() };
        }),
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
    (window.createWebviewPanel as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockPanel);
    const context = {
      extensionUri: Uri.file("/fake/extension"),
      subscriptions: [] as { dispose: () => void }[],
    };
    const executeSpy = vi.spyOn(harness.engine, "executeQuery");

    openQueryEditor(context as never, registry, harness.engine);
    await expect(messageHandler!(message)).resolves.toBeUndefined();

    expect(executeSpy).not.toHaveBeenCalled();
    expect(postedMessages).toContainEqual({
      type: "queryError",
      payload: { message: expect.stringMatching(/malformed/i) },
      tabId: "",
    });
  });

  it("setWorkspaceQueries pushes savedQueries to existing panel (Fix 2)", async () => {
    harness = await createEngine();
    const registry = new TableRegistry();
    registry.add({
      name: "sales",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
    });

    let messageHandler: ((msg: any) => Promise<void>) | undefined;
    const postedMessages: any[] = [];
    const mockPanel = {
      webview: {
        postMessage: vi.fn((message: unknown) => {
          postedMessages.push(message);
          return Promise.resolve(true);
        }),
        onDidReceiveMessage: vi.fn((handler: (msg: any) => Promise<void>) => {
          messageHandler = handler;
          return { dispose: vi.fn() };
        }),
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
    (window.createWebviewPanel as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockPanel);
    const context = {
      extensionUri: Uri.file("/fake/extension"),
      subscriptions: [] as { dispose: () => void }[],
    };

    openQueryEditor(context as never, registry, harness.engine);
    await messageHandler!({ type: "ready" });

    // Clear postedMessages and call setWorkspaceQueries again (simulating import/reread)
    postedMessages.length = 0;
    setWorkspaceQueries([{ name: "refreshed", sql: "SELECT 42" }]);

    // Second call with panel already open pushes immediately
    expect(postedMessages).toContainEqual({
      type: "savedQueries",
      payload: { queries: [{ name: "refreshed", sql: "SELECT 42" }] },
    });
  });

  it("second open/reveal posts updated savedQueries (Fix 2)", async () => {
    harness = await createEngine();
    const registry = new TableRegistry();
    registry.add({
      name: "sales",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
    });
    setWorkspaceQueries([{ name: "initial", sql: "SELECT 1" }]);

    let messageHandler: ((msg: any) => Promise<void>) | undefined;
    const postedMessages: any[] = [];
    const mockPanel = {
      webview: {
        postMessage: vi.fn((message: unknown) => {
          postedMessages.push(message);
          return Promise.resolve(true);
        }),
        onDidReceiveMessage: vi.fn((handler: (msg: any) => Promise<void>) => {
          messageHandler = handler;
          return { dispose: vi.fn() };
        }),
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
    (window.createWebviewPanel as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockPanel);
    const context = {
      extensionUri: Uri.file("/fake/extension"),
      subscriptions: [] as { dispose: () => void }[],
    };

    // First open
    openQueryEditor(context as never, registry, harness.engine);
    await messageHandler!({ type: "ready" });

    // Update queries and call open again (reveal branch)
    setWorkspaceQueries([{ name: "updated", sql: "SELECT 2" }]);
    postedMessages.length = 0;
    openQueryEditor(context as never, registry, harness.engine);

    // Reveal branch should post updated savedQueries
    expect(mockPanel.reveal).toHaveBeenCalled();
    // The setWorkspaceQueries above already posts, plus reveal branch posts tables
    expect(postedMessages.some((m: any) => m.type === "savedQueries")).toBe(true);
    expect(postedMessages.some((m: any) => m.type === "openTableQuery")).toBe(false);
    expect(postedMessages).toContainEqual({ type: "openNewQuery" });

    postedMessages.length = 0;
    openQueryEditor(context as never, registry, harness.engine, "sales");
    expect(postedMessages).toContainEqual({
      type: "openTableQuery",
      payload: {
        query: { name: "sales", sql: 'SELECT *\nFROM "sales"' },
      },
    });
  });

  it("requestQueryTabsSnapshot returns latest from webview (Fix 3)", async () => {
    harness = await createEngine();
    const registry = new TableRegistry();
    registry.add({
      name: "sales",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
    });

    let messageHandler: ((msg: any) => Promise<void>) | undefined;
    const postedMessages: any[] = [];
    const mockPanel = {
      webview: {
        postMessage: vi.fn((message: unknown) => {
          postedMessages.push(message);
          // Auto-respond to snapshot requests simulating webview
          if ((message as any).type === "requestQueryTabs") {
            const requestId = (message as any).payload?.requestId;
            setTimeout(() => {
              messageHandler!({
                type: "queryTabsSnapshot",
                payload: {
                  requestId,
                  queries: [{ name: "live-tab", sql: "SELECT live" }],
                },
              });
            }, 5);
          }
          return Promise.resolve(true);
        }),
        onDidReceiveMessage: vi.fn((handler: (msg: any) => Promise<void>) => {
          messageHandler = handler;
          return { dispose: vi.fn() };
        }),
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
    (window.createWebviewPanel as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockPanel);
    const context = {
      extensionUri: Uri.file("/fake/extension"),
      subscriptions: [] as { dispose: () => void }[],
    };

    openQueryEditor(context as never, registry, harness.engine);
    await messageHandler!({ type: "ready" });

    // Request snapshot — should get live-tab back from webview
    const snapshot = await requestQueryTabsSnapshot();
    expect(snapshot).toEqual([{ name: "live-tab", sql: "SELECT live" }]);
  });

  it("requestQueryTabsSnapshot falls back to host queries when no panel (Fix 3)", async () => {
    // No panel open — should return host-side queries
    setWorkspaceQueries([{ name: "host-query", sql: "SELECT host" }]);
    const snapshot = await requestQueryTabsSnapshot();
    expect(snapshot).toEqual([{ name: "host-query", sql: "SELECT host" }]);
  });

  it("requestQueryTabsSnapshot rejects on panel dispose (Fix 3)", async () => {
    harness = await createEngine();
    const registry = new TableRegistry();
    registry.add({
      name: "sales",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
    });

    let messageHandler: ((msg: any) => Promise<void>) | undefined;
    const mockPanel = {
      webview: {
        postMessage: vi.fn((message: unknown) => {
          // Do NOT respond to snapshot — simulate dispose before response
          if ((message as any).type === "requestQueryTabs") {
            setTimeout(() => disposeHandler!(), 10);
          }
          return Promise.resolve(true);
        }),
        onDidReceiveMessage: vi.fn((handler: (msg: any) => Promise<void>) => {
          messageHandler = handler;
          return { dispose: vi.fn() };
        }),
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
    (window.createWebviewPanel as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockPanel);
    const context = {
      extensionUri: Uri.file("/fake/extension"),
      subscriptions: [] as { dispose: () => void }[],
    };

    openQueryEditor(context as never, registry, harness.engine);
    await messageHandler!({ type: "ready" });

    await expect(requestQueryTabsSnapshot()).rejects.toThrow(/disposed/);
  });

  it("setWorkspaceQueries + reveal sends savedQueries only once (idempotent delivery)", async () => {
    harness = await createEngine();
    const registry = new TableRegistry();
    registry.add({
      name: "sales",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
    });

    let messageHandler: ((msg: any) => Promise<void>) | undefined;
    const postedMessages: any[] = [];
    const mockPanel = {
      webview: {
        postMessage: vi.fn((message: unknown) => {
          postedMessages.push(message);
          return Promise.resolve(true);
        }),
        onDidReceiveMessage: vi.fn((handler: (msg: any) => Promise<void>) => {
          messageHandler = handler;
          return { dispose: vi.fn() };
        }),
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
    (window.createWebviewPanel as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockPanel);
    const context = {
      extensionUri: Uri.file("/fake/extension"),
      subscriptions: [] as { dispose: () => void }[],
    };

    // Open panel (first time) and hydrate
    openQueryEditor(context as never, registry, harness.engine);
    await messageHandler!({ type: "ready" });

    // Import calls setWorkspaceQueries, which posts savedQueries to already-open panel
    const queries = [{ name: "report", sql: "SELECT 1" }];
    setWorkspaceQueries(queries);

    // Then reveals the panel — which also posts savedQueries again
    openQueryEditor(context as never, registry, harness.engine);

    // Count how many savedQueries messages were posted with the imported queries
    const savedQueriesMessages = postedMessages.filter(
      (m: any) => m.type === "savedQueries",
    );
    // The "ready" handler sent one with [] (before import), then setWorkspaceQueries
    // and reveal both send with the imported queries. The webview dedup prevents
    // duplicate tabs on repeated identical delivery.
    const importedDeliveries = savedQueriesMessages.filter(
      (m: any) => m.payload.queries.length > 0,
    );
    // Both setWorkspaceQueries and reveal delivered the same payload
    for (const msg of importedDeliveries) {
      expect(msg.payload.queries).toEqual(queries);
    }
    // Verify both paths delivered (setWorkspaceQueries + reveal)
    expect(importedDeliveries.length).toBe(2);
  });
});
