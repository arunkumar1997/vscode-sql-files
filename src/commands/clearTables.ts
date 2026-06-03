import * as vscode from "vscode";
import { DuckDBEngine } from "../duckdbEngine";
import { TableRegistry } from "../tableRegistry";

export async function clearTables(
  registry: TableRegistry,
  engine: DuckDBEngine,
): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    "Remove all loaded tables?",
    { modal: true },
    "Yes",
  );
  if (confirm !== "Yes") {
    return;
  }

  for (const entry of registry.getAll()) {
    try {
      await engine.dropTable(entry.name);
    } catch {}
  }
  registry.clear();
}

export async function removeTable(
  tableName: string,
  registry: TableRegistry,
  engine: DuckDBEngine,
): Promise<void> {
  try {
    await engine.dropTable(tableName);
  } catch {}
  registry.remove(tableName);
}

export async function renameTable(
  oldName: string,
  registry: TableRegistry,
  engine: DuckDBEngine,
): Promise<void> {
  const newName = await vscode.window.showInputBox({
    prompt: "Enter new table name",
    value: oldName,
    validateInput: (v) => {
      if (!v.trim()) {
        return "Name cannot be empty";
      }
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(v.trim())) {
        return "Use only letters, digits, and underscores; must start with a letter or underscore";
      }
      if (registry.has(v.trim()) && v.trim() !== oldName) {
        return "A table with that name already exists";
      }
      return null;
    },
  });

  if (!newName || newName.trim() === oldName) {
    return;
  }

  const trimmed = newName.trim();
  const entry = registry.get(oldName);
  if (!entry) {
    return;
  }

  try {
    registry.rename(oldName, trimmed);          // updates entry.name in-place
    await engine.renameTable(oldName, entry);   // drops old VIEW, creates new one
  } catch (err: unknown) {
    // Roll back registry rename on engine failure
    registry.rename(trimmed, oldName);
    vscode.window.showErrorMessage(`Rename failed: ${(err as Error).message}`);
  }
}
