import { describe, it, expect, afterEach, vi } from "vitest";
import path from "path";
import { createEngine, EngineHarness } from "../helpers/duckdbHarness";
import { TableRegistry } from "../../src/tableRegistry";
import { openQueryEditor } from "../../src/commands/openQueryEditor";
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

    openQueryEditor(context as never, registry, harness.engine);

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
});
