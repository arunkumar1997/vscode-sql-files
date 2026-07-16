import * as fs from "fs";
import * as vscode from "vscode";
import { DuckDBEngine } from "./duckdbEngine";
import { TableRegistry } from "./tableRegistry";
import { TablesTreeProvider } from "./providers/tablesTreeProvider";
import { addPath } from "./commands/addPath";
import { addFolder } from "./commands/addFolder";
import { entryFromLocalFile } from "./fileScanner";
import {
  hasWorkspaceQueries,
  openQueryEditor,
  requestQueryTabsSnapshot,
  setWorkspaceQueries,
} from "./commands/openQueryEditor";
import { clearTables, removeTable, renameTable } from "./commands/clearTables";
import { SqlCompletionProvider } from "./providers/completionProvider";
import { cleanupTempDir } from "./s3Handler";
import { TableEntry } from "./types";
import { initLogger, log } from "./logger";
import {
  loadTable,
  triggerAutoLoadLocal,
  importWorkspaceConfig,
  unloadTable,
  reloadTable,
  saveWorkspaceConfig,
} from "./commands/configCommands";
import { readConfig, readSavedQueries } from "./configManager";

/** Exposed only when running inside the VS Code test host. */
export interface TestApi {
  getEngine(): DuckDBEngine | undefined;
  getRegistry(): TableRegistry | undefined;
}

let engine: DuckDBEngine | undefined;
let registry: TableRegistry | undefined;

export function tableNameFromContext(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const entry = (value as { entry?: { name?: unknown } }).entry;
  return typeof entry?.name === "string" && entry.name.length > 0
    ? entry.name
    : undefined;
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<TestApi | void> {
  initLogger();
  log("File SQL extension activating...");

  engine = new DuckDBEngine();
  registry = new TableRegistry();
  registry.setStorage(context.workspaceState);

  // Restore persisted tables — engine will be lazily initialized on first use
  const savedEntries = registry.loadFromStorage();
  log(`Restored ${savedEntries.length} persisted table(s)`);
  if (savedEntries.length > 0) {
    restoreEntries(savedEntries, registry, engine);
  }

  // Slice 7: Read .filesql/config.json and register configured (unloaded) entries
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  if (wsFolder) {
    try {
      const { entries, diagnostics, missing } = await readConfig(wsFolder.uri);
      if (!missing && entries.length > 0) {
        registry.addConfigured(entries);
        log(`Registered ${entries.length} configured table(s) from .filesql/config.json`);
      }
      for (const d of diagnostics) {
        log(`[config] ${d.message}`);
      }
    } catch (err) {
      log(`[config] Error reading workspace config: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const queries = await readSavedQueries(wsFolder.uri);
      setWorkspaceQueries(queries);
      log(`Restored ${queries.length} saved quer${queries.length === 1 ? "y" : "ies"}`);
    } catch (err) {
      log(`[config] Error reading saved queries: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const treeProvider = new TablesTreeProvider(registry);
  const treeView = vscode.window.createTreeView("fileSqlTables", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  const EMPTY_MSG =
    "No tables yet. Use the + or folder buttons above to load a CSV, JSON, or Parquet file.";

  function refreshTreeMessage(): void {
    treeView.message = registry!.getAll().length === 0 ? EMPTY_MSG : undefined;
  }

  refreshTreeMessage();
  context.subscriptions.push(registry.onDidChange(() => refreshTreeMessage()));

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
    vscode.commands.registerCommand(
      "fileSql.openQueryEditor",
      (argument?: unknown) => {
        const tableName =
          tableNameFromContext(argument) ??
          tableNameFromContext(treeView.selection[0]);
        openQueryEditor(context, registry!, engine!, tableName);
      },
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

    vscode.commands.registerCommand(
      "fileSql.loadTable",
      (item?: { entry: { name: string } }) => {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wsRoot) {
          vscode.window.showErrorMessage("File SQL: No workspace folder open.");
          return;
        }
        if (item?.entry?.name) {
          return vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `File SQL: Loading ${item.entry.name}…`, cancellable: true },
            (progress, token) => loadTable(item.entry.name, registry!, engine!, wsRoot, progress, token),
          );
        }
      },
    ),

    vscode.commands.registerCommand("fileSql.importWorkspaceConfig", async () => {
      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      if (!wsFolder) {
        vscode.window.showErrorMessage("File SQL: No workspace folder open.");
        return;
      }
      const imported = await importWorkspaceConfig(registry!, wsFolder.uri);
      if (imported) {
        await triggerAutoLoadLocal(
          registry!,
          engine!,
          wsFolder.uri.fsPath,
        );
        // Item 5: Always reread queries from disk on import
        try {
          const queries = await readSavedQueries(wsFolder.uri);
          setWorkspaceQueries(queries);
          log(`Re-read ${queries.length} saved quer${queries.length === 1 ? "y" : "ies"} from disk`);
        } catch (err) {
          log(`[config] Error re-reading saved queries: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (hasWorkspaceQueries() && registry!.getAll().length > 0) {
          openQueryEditor(context, registry!, engine!, false);
        }
      }
    }),

    vscode.commands.registerCommand(
      "fileSql.unloadTable",
      (item?: { entry: { name: string } }) => {
        if (item?.entry?.name) {
          return unloadTable(item.entry.name, registry!, engine!);
        }
      },
    ),

    vscode.commands.registerCommand(
      "fileSql.reloadTable",
      (item?: { entry: { name: string } }) => {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wsRoot) {
          vscode.window.showErrorMessage("File SQL: No workspace folder open.");
          return;
        }
        if (item?.entry?.name) {
          return reloadTable(item.entry.name, registry!, engine!, wsRoot);
        }
      },
    ),

    vscode.commands.registerCommand("fileSql.saveWorkspaceConfig", async () => {
      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      if (!wsFolder) {
        vscode.window.showErrorMessage("File SQL: No workspace folder open.");
        return;
      }
      // Request current tab snapshot from webview (or use host state if no panel)
      let queries: import("./types").SavedQuery[];
      try {
        queries = await requestQueryTabsSnapshot();
      } catch (err) {
        vscode.window.showErrorMessage(
          `File SQL: Failed to get current query state — ${(err as Error).message}`,
        );
        return;
      }
      return saveWorkspaceConfig(registry!, wsFolder.uri, queries);
    }),

    vscode.languages.registerCompletionItemProvider(
      [{ language: "sql" }, { language: "plaintext" }],
      new SqlCompletionProvider(registry),
      ".",
    ),

    vscode.commands.registerCommand(
      "fileSql.openFileInSql",
      async (uri: vscode.Uri) => {
        const entry = entryFromLocalFile(uri.fsPath);
        if (!entry) {
          vscode.window.showErrorMessage(
            `File SQL: Unsupported file type for ${uri.fsPath}`,
          );
          return;
        }
        try {
          await engine!.ensureInitialized();
          const cols = await engine!.registerTable(entry);
          entry.columns = cols;
          registry!.add(entry);
          // Switch to the File SQL panel so the user sees the newly added table
          await vscode.commands.executeCommand(
            "workbench.view.extension.fileSqlExplorer",
          );

          // open query editor with the table name pre-filled
          await vscode.commands.executeCommand("fileSql.openQueryEditor", entry.name);

          vscode.window.showInformationMessage(
            `File SQL: Added table "${entry.name}".`,
          );
        } catch (err: unknown) {
          vscode.window.showErrorMessage(
            `File SQL: Failed to load — ${(err as Error).message}`,
          );
        }
      },
    ),
  );

  if (hasWorkspaceQueries() && registry.getAll().length > 0) {
    openQueryEditor(context, registry, engine, false);
  }
  if (wsFolder) {
    void triggerAutoLoadLocal(registry, engine, wsFolder.uri.fsPath);
  }

  // Expose test API only when running in the Extension Development Host
  if (context.extensionMode === vscode.ExtensionMode.Test) {
    return {
      getEngine: () => engine,
      getRegistry: () => registry,
    };
  }
}

/** Re-register persisted tables with DuckDB in the background. */
async function restoreEntries(
  entries: TableEntry[],
  registry: TableRegistry,
  engine: DuckDBEngine,
): Promise<void> {
  try {
    await engine.ensureInitialized();
  } catch {
    // Engine init failed — remove all persisted entries since we can't register them
    for (const entry of entries) {
      registry.remove(entry.name);
    }
    return;
  }

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
