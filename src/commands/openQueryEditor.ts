import * as vscode from "vscode";
import { DuckDBEngine } from "../duckdbEngine";
import { TableRegistry } from "../tableRegistry";
import { TableEntry } from "../types";
import { getConfig } from "../s3Handler";

let panel: vscode.WebviewPanel | undefined;

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
    },
    undefined,
    context.subscriptions,
  );

  panel.onDidDispose(() => {
    panel = undefined;
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
