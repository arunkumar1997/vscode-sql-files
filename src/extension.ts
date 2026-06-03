import * as fs from "fs";
import * as vscode from "vscode";
import { DuckDBEngine } from "./duckdbEngine";
import { TableRegistry } from "./tableRegistry";
import { TablesTreeProvider } from "./providers/tablesTreeProvider";
import { addPath } from "./commands/addPath";
import { addFolder } from "./commands/addFolder";
import { openQueryEditor } from "./commands/openQueryEditor";
import { clearTables, removeTable, renameTable } from "./commands/clearTables";
import { SqlCompletionProvider } from "./providers/completionProvider";
import { cleanupTempDir } from "./s3Handler";
import { TableEntry } from "./types";
import { initLogger, log, logError } from "./logger";

let engine: DuckDBEngine | undefined;
let registry: TableRegistry | undefined;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  initLogger();
  log("File SQL extension activating...");

  engine = new DuckDBEngine();
  registry = new TableRegistry();
  registry.setStorage(context.workspaceState);

  try {
    log("Initializing DuckDB engine...");
    await engine.init();
    log("DuckDB engine initialized successfully");
  } catch (err: unknown) {
    logError("DuckDB failed to initialize", err);
    vscode.window.showErrorMessage(
      `File SQL: DuckDB failed to initialize — ${(err as Error).message}`,
    );
  }

  // Restore persisted tables (only if engine initialized successfully)
  if (engine.isReady()) {
    const savedEntries = registry.loadFromStorage();
    log(`Restored ${savedEntries.length} persisted table(s)`);
    if (savedEntries.length > 0) {
      restoreEntries(savedEntries, registry, engine);
    }
  }

  const treeProvider = new TablesTreeProvider(registry);
  const treeView = vscode.window.createTreeView("fileSqlTables", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  context.subscriptions.push(
    treeView,
    treeProvider,
    registry,

    vscode.commands.registerCommand("fileSql.addPath", () =>
      addPath(registry!, engine!),
    ),
    vscode.commands.registerCommand("fileSql.addFolder", () =>
      addFolder(registry!, engine!),
    ),
    vscode.commands.registerCommand("fileSql.openQueryEditor", () =>
      openQueryEditor(context, registry!, engine!),
    ),
    vscode.commands.registerCommand("fileSql.clearTables", () =>
      clearTables(registry!, engine!),
    ),
    vscode.commands.registerCommand(
      "fileSql.removeTable",
      (item: { entry: { name: string } }) =>
        removeTable(item.entry.name, registry!, engine!),
    ),

    vscode.commands.registerCommand(
      "fileSql.renameTable",
      (item: { entry: { name: string } }) =>
        renameTable(item.entry.name, registry!, engine!),
    ),

    vscode.commands.registerCommand(
      "fileSql.copyTableName",
      (item: { entry: { name: string } }) => {
        vscode.env.clipboard.writeText(item.entry.name);
        vscode.window.showInformationMessage(`Copied: ${item.entry.name}`);
      },
    ),

    vscode.commands.registerCommand(
      "fileSql.copyColumnName",
      (item: { label: string | vscode.TreeItemLabel }) => {
        const name =
          typeof item.label === "string" ? item.label : item.label.label;
        vscode.env.clipboard.writeText(name);
        vscode.window.showInformationMessage(`Copied: ${name}`);
      },
    ),

    vscode.languages.registerCompletionItemProvider(
      [{ language: "sql" }, { language: "plaintext" }],
      new SqlCompletionProvider(registry),
      ".",
    ),
  );
}

/** Re-register persisted tables with DuckDB in the background. */
async function restoreEntries(
  entries: TableEntry[],
  registry: TableRegistry,
  engine: DuckDBEngine,
): Promise<void> {
  for (const entry of entries) {
    // Skip S3 entries whose temp files no longer exist
    if (entry.isS3 && !fs.existsSync(entry.filePath)) {
      registry.remove(entry.name);
      continue;
    }
    // Skip local files that were deleted
    if (!entry.isS3 && !fs.existsSync(entry.filePath)) {
      registry.remove(entry.name);
      continue;
    }
    try {
      const cols = await engine.registerTable(entry);
      registry.updateColumns(entry.name, cols);
    } catch {
      // File may have moved — remove from registry silently
      registry.remove(entry.name);
    }
  }
}

export function deactivate(): void {
  log("File SQL extension deactivating...");
  engine?.dispose();
  registry?.dispose();
  cleanupTempDir();
}
