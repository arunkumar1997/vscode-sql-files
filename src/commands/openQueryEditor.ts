import * as vscode from "vscode";
import { DuckDBEngine } from "../duckdbEngine";
import { TableRegistry } from "../tableRegistry";
import { ExportFormat, TableEntry } from "../types";
import { getConfig } from "../s3Handler";

const VALID_EXPORT_FORMATS = new Set<string>(["csv", "parquet"]);

let panel: vscode.WebviewPanel | undefined;
/** Track the original SQL per tab for export (keyed by tabId). */
const tabSqlMap = new Map<string, string>();

export function isQueryEditorOpen(): boolean {
  return panel !== undefined;
}

export function openQueryEditor(
  context: vscode.ExtensionContext,
  registry: TableRegistry,
  engine: DuckDBEngine,
): void {
  if (registry.getAll().length === 0) {
    vscode.window.showInformationMessage("Please add a file or folder before opening the Query Editor.");
    if (panel) {
      panel.dispose();
    }
    return;
  }
  if (panel) {
    panel.reveal(vscode.ViewColumn.One);
    sendTables(registry.getAll());
    return;
  }

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
    const tables = registry.getAll();
    if (tables.length === 0) {
      panel?.dispose();
    } else {
      sendTables(tables);
    }
  });
  context.subscriptions.push(tablesSub);

  panel.webview.onDidReceiveMessage(
    async (msg) => {
      if (msg.type === "ready") {
        sendTables(registry.getAll());
        return;
      }
      if (msg.type === "runQuery") {
        const { sql, tabId } = msg.payload as { sql: string; tabId: string };
        const { maxRows } = getConfig();
        // Store original SQL for export
        tabSqlMap.set(tabId, sql);
        try {
          const result = await engine.executeQuery(sql, maxRows);
          panel?.webview.postMessage({
            type: "queryResult",
            payload: result,
            tabId,
          });
        } catch (err: unknown) {
          panel?.webview.postMessage({
            type: "queryError",
            payload: { message: (err as Error).message },
            tabId,
          });
        }
      }
      if (msg.type === "exportResults") {
        const payload = msg.payload as { tabId?: string; format?: string } | null | undefined;
        if (!payload || typeof payload.tabId !== "string" || typeof payload.format !== "string") {
          panel?.webview.postMessage({
            type: "exportError",
            payload: { message: "Malformed export request: missing tabId or format." },
            tabId: payload?.tabId ?? "",
          });
          return;
        }
        const { tabId, format } = payload;

        // Validate format at extension boundary
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

        // User cancelled
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
    },
    undefined,
    context.subscriptions,
  );

  panel.onDidDispose(() => {
    panel = undefined;
    tabSqlMap.clear();
    tablesSub.dispose();
  });
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
