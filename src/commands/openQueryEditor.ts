import * as vscode from "vscode";
import * as crypto from "crypto";
import { DuckDBEngine, escapeDuckDBIdentifier } from "../duckdbEngine";
import { TableRegistry } from "../tableRegistry";
import { ExportFormat, SavedQuery, TableEntry } from "../types";
import { getConfig } from "../s3Handler";
import { ensureUniqueQueryNames } from "../queryNames";

const VALID_EXPORT_FORMATS = new Set<string>(["csv", "parquet"]);

let panel: vscode.WebviewPanel | undefined;
/** Track the original SQL per tab for export (keyed by tabId). */
const tabSqlMap = new Map<string, string>();
let workspaceQueries: SavedQuery[] = [];
let pendingTableQuery: SavedQuery | undefined;

/** Pending snapshot requests keyed by request id. */
const pendingSnapshots = new Map<string, { resolve: (queries: SavedQuery[]) => void; reject: (err: Error) => void }>();

/** Timeout for snapshot requests (ms). */
const SNAPSHOT_TIMEOUT_MS = 3000;

export function setWorkspaceQueries(queries: SavedQuery[]): void {
  workspaceQueries = ensureUniqueQueryNames(queries);
  // If panel is already open, push updated queries immediately
  if (panel) {
    panel.webview.postMessage({
      type: "savedQueries",
      payload: { queries: workspaceQueries },
    });
  }
}

export function getWorkspaceQueries(): SavedQuery[] {
  return workspaceQueries;
}

export function hasWorkspaceQueries(): boolean {
  return workspaceQueries.length > 0;
}

export function isQueryEditorOpen(): boolean {
  return panel !== undefined;
}

export function createTableQuery(tableName: string): SavedQuery {
  return {
    name: tableName,
    sql: `SELECT *\nFROM ${escapeDuckDBIdentifier(tableName)}`,
  };
}

function sendTableQuery(query: SavedQuery): void {
  panel?.webview.postMessage({
    type: "openTableQuery",
    payload: { query },
  });
}

function sendNewQuery(): void {
  panel?.webview.postMessage({ type: "openNewQuery" });
}

/**
 * Request a current tab snapshot from an open webview panel.
 * Returns the webview's current React state immediately (not debounced).
 * If no panel is open, returns host-side workspaceQueries.
 * If response times out or panel disposes, throws with a clear message.
 */
export async function requestQueryTabsSnapshot(): Promise<SavedQuery[]> {
  if (!panel) {
    return workspaceQueries;
  }
  const requestId = crypto.randomBytes(8).toString("hex");
  return new Promise<SavedQuery[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingSnapshots.delete(requestId);
      reject(new Error("Query tabs snapshot timed out — panel did not respond within 3 seconds."));
    }, SNAPSHOT_TIMEOUT_MS);

    pendingSnapshots.set(requestId, {
      resolve: (queries) => {
        clearTimeout(timer);
        pendingSnapshots.delete(requestId);
        resolve(queries);
      },
      reject: (err) => {
        clearTimeout(timer);
        pendingSnapshots.delete(requestId);
        reject(err);
      },
    });

    panel!.webview.postMessage({ type: "requestQueryTabs", payload: { requestId } });
  });
}

export function openQueryEditor(
  context: vscode.ExtensionContext,
  registry: TableRegistry,
  engine: DuckDBEngine,
  tableName?: unknown,
): void {
  const requestedTableName =
    typeof tableName === "string" && tableName.length > 0
      ? tableName
      : undefined;

  if (registry.getAll().length === 0) {
    vscode.window.showInformationMessage("Please add a file or folder before opening the Query Editor.");
    if (panel) {
      panel.dispose();
    }
    return;
  }
  if (panel) {
    panel.reveal(vscode.ViewColumn.One);
    sendTables(registry.getLoaded());
    panel.webview.postMessage({
      type: "savedQueries",
      payload: { queries: workspaceQueries },
    });
    if (requestedTableName) {
      sendTableQuery(createTableQuery(requestedTableName));
    } else if (tableName !== false) {
      sendNewQuery();
    }
    return;
  }

  pendingTableQuery = requestedTableName
    ? createTableQuery(requestedTableName)
    : undefined;

  panel = vscode.window.createWebviewPanel(
    "fileSqlEditor",
    "File SQL — Query Editor",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [context.extensionUri],
    },
  );

  const scriptUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "dist", "webview.js"),
  );
  const styleUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "dist", "webview.css"),
  );

  panel.webview.html = buildHtml(panel.webview, scriptUri, styleUri);

  const tablesSub = registry.onDidChange(() => {
    const tables = registry.getLoaded();
    if (tables.length === 0 && registry.getAll().length === 0) {
      panel?.dispose();
    } else {
      sendTables(tables);
    }
  });
  context.subscriptions.push(tablesSub);

  panel.webview.onDidReceiveMessage(
    async (msg) => {
      if (msg.type === "ready") {
        sendTables(registry.getLoaded());
        panel?.webview.postMessage({
          type: "savedQueries",
          payload: { queries: workspaceQueries },
        });
        if (pendingTableQuery) {
          sendTableQuery(pendingTableQuery);
          pendingTableQuery = undefined;
        }
        return;
      }
      if (msg.type === "queryTabsChanged") {
        const queries = (msg.payload as { queries?: unknown })?.queries;
        if (Array.isArray(queries)) {
          workspaceQueries = ensureUniqueQueryNames(
            queries.filter(
              (query): query is SavedQuery =>
                typeof query === "object" &&
                query !== null &&
                typeof (query as SavedQuery).name === "string" &&
                typeof (query as SavedQuery).sql === "string",
            ),
          );
        }
        return;
      }
      if (msg.type === "queryTabsSnapshot") {
        const payload = msg.payload as { requestId?: string; queries?: unknown } | undefined;
        const requestId = payload?.requestId;
        if (typeof requestId === "string" && pendingSnapshots.has(requestId)) {
          const pending = pendingSnapshots.get(requestId)!;
          const queries = payload?.queries;
          if (Array.isArray(queries)) {
            const valid = queries.filter(
              (q): q is SavedQuery =>
                typeof q === "object" && q !== null &&
                typeof (q as SavedQuery).name === "string" &&
                typeof (q as SavedQuery).sql === "string",
            );
            pending.resolve(ensureUniqueQueryNames(valid));
          } else {
            pending.resolve(workspaceQueries);
          }
        }
        return;
      }
      if (msg.type === "runQuery") {
        await handleRunQuery(msg.payload, engine, registry);
        return;
      }
      if (msg.type === "exportResults") {
        await handleExportResults(msg.payload, engine);
      }
    },
    undefined,
    context.subscriptions,
  );

  panel.onDidDispose(() => {
    // Reject any pending snapshot requests
    for (const [, pending] of pendingSnapshots) {
      pending.reject(new Error("Query Editor panel was disposed before snapshot response."));
    }
    pendingSnapshots.clear();
    panel = undefined;
    pendingTableQuery = undefined;
    tabSqlMap.clear();
    tablesSub.dispose();
  });
}

async function handleRunQuery(
  payload: unknown,
  engine: DuckDBEngine,
  registry: TableRegistry,
): Promise<void> {
  const query = payload as { sql?: unknown; tabId?: unknown } | null | undefined;
  if (!query || typeof query.sql !== "string" || typeof query.tabId !== "string") {
    panel?.webview.postMessage({
      type: "queryError",
      payload: { message: "Malformed query request: missing sql or tabId." },
      tabId: typeof query?.tabId === "string" ? query.tabId : "",
    });
    return;
  }

  const { sql, tabId } = query;
  const { maxRows } = getConfig();
  tabSqlMap.set(tabId, sql);
  try {
    const result = await engine.executeQuery(sql, maxRows);
    panel?.webview.postMessage({ type: "queryResult", payload: result, tabId });
  } catch (err: unknown) {
    const message = formatQueryError(err, registry);
    panel?.webview.postMessage({
      type: "queryError",
      payload: { message },
      tabId,
    });
  }
}

function formatQueryError(error: unknown, registry: TableRegistry): string {
  const message = error instanceof Error ? error.message : String(error);
  const missingRelation = message.match(
    /table with name\s+["'`]?(.+?)["'`]?\s+does not exist/i,
  )?.[1];
  if (!missingRelation) {
    return message;
  }

  const normalizedRelation = missingRelation.toLocaleLowerCase();
  const unloadedTable = registry
    .getAll()
    .find(
      (entry) =>
        (entry.loadState === "configured" || entry.loadState === "error") &&
        entry.name.toLocaleLowerCase() === normalizedRelation,
    );
  if (!unloadedTable) {
    return message;
  }

  return `Table "${unloadedTable.name}" is not loaded. Load it from File SQL Tables, then run the query again.`;
}

async function handleExportResults(payload: unknown, engine: DuckDBEngine): Promise<void> {
  const request = payload as { tabId?: string; format?: string } | null | undefined;
  if (!request || typeof request.tabId !== "string" || typeof request.format !== "string") {
    panel?.webview.postMessage({
      type: "exportError",
      payload: { message: "Malformed export request: missing tabId or format." },
      tabId: request?.tabId ?? "",
    });
    return;
  }

  const { tabId, format } = request;
  if (!VALID_EXPORT_FORMATS.has(format)) {
    panel?.webview.postMessage({
      type: "exportError",
      payload: { message: `Unsupported export format: "${format}". Use "csv" or "parquet".` },
      tabId,
    });
    return;
  }

  const exportFormat = format as ExportFormat;
  const filterLabel = exportFormat === "csv" ? "CSV Files" : "Parquet Files";
  const ext = exportFormat === "csv" ? "csv" : "parquet";
  const uri = await vscode.window.showSaveDialog({
    filters: { [filterLabel]: [ext] },
    defaultUri: vscode.Uri.file(`export.${ext}`),
  });
  if (!uri) return;

  const sql = tabSqlMap.get(tabId);
  if (!sql) {
    panel?.webview.postMessage({
      type: "exportError",
      payload: { message: "No query to export. Run a query first." },
      tabId,
    });
    return;
  }

  try {
    await engine.exportQuery(sql, uri.fsPath, exportFormat);
    panel?.webview.postMessage({
      type: "exportResult",
      payload: { path: uri.fsPath, format: exportFormat },
      tabId,
    });
  } catch (err: unknown) {
    panel?.webview.postMessage({
      type: "exportError",
      payload: { message: (err as Error).message },
      tabId,
    });
  }
}

function sendTables(tables: TableEntry[]): void {
  panel?.webview.postMessage({ type: "tablesChanged", payload: { tables } });
}

function getNonce(): string {
  let text = "";
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function buildHtml(
  webview: vscode.Webview,
  scriptUri: vscode.Uri,
  styleUri: vscode.Uri,
): string {
  const nonce = getNonce();
  const csp = webview.cspSource;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             img-src ${csp} data:;
             style-src ${csp} 'unsafe-inline';
             script-src 'nonce-${nonce}';" />
  <title>File SQL</title>
  <link rel="stylesheet" href="${styleUri}" />
  <style>
    html, body, #root { margin: 0; padding: 0; height: 100%; width: 100%; overflow: hidden; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
