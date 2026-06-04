import * as vscode from "vscode";
import { isQueryEditorOpen } from "./openQueryEditor";
import { DuckDBEngine } from "../duckdbEngine";
import { TableRegistry } from "../tableRegistry";
import { scanFolder } from "../fileScanner";
import { TableEntry } from "../types";

export async function addFolder(
  registry: TableRegistry,
  engine: DuckDBEngine,
): Promise<void> {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Select Folder",
  });

  if (!uris || uris.length === 0) {
    return;
  }

  const folderPath = uris[0].fsPath;
  const entries = scanFolder(folderPath);

  if (entries.length === 0) {
    vscode.window.showWarningMessage(
      "No supported files found in that folder.",
    );
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "File SQL: Loading folder…",
    },
    async (progress) => {
      for (const entry of entries) {
        progress.report({ message: `Registering ${entry.name}…` });
        try {
          const cols = await engine.registerTable(entry);
          entry.columns = cols;
          registry.add(entry);
        } catch (err: unknown) {
          vscode.window.showErrorMessage(
            `Failed to load ${entry.name}: ${(err as Error).message}`,
          );
        }
      }
      vscode.window.showInformationMessage(
        `File SQL: Loaded ${entries.length} table(s) from folder.`,
      );
      if (!isQueryEditorOpen()) {
        vscode.commands.executeCommand("fileSql.openQueryEditor");
      }
    },
  );
}
