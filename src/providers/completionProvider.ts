import * as vscode from "vscode";
import { TableRegistry } from "../tableRegistry";

export class SqlCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly registry: TableRegistry) { }

  provideCompletionItems(): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];

    for (const entry of this.registry.getLoaded()) {
      const tableItem = new vscode.CompletionItem(
        entry.name,
        vscode.CompletionItemKind.Class,
      );
      tableItem.detail = `${entry.fileType} table`;
      tableItem.documentation = entry.filePath;
      items.push(tableItem);

      for (const col of entry.columns ?? []) {
        const colItem = new vscode.CompletionItem(
          col.name,
          vscode.CompletionItemKind.Field,
        );
        colItem.detail = `${col.type} — ${entry.name}`;
        items.push(colItem);
      }
    }

    return items;
  }
}
