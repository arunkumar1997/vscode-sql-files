import * as vscode from "vscode";
import { TableRegistry } from "../tableRegistry";

export class SqlCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly registry: TableRegistry) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    const linePrefix = document
      .lineAt(position)
      .text.substring(0, position.character)
      .toLowerCase();

    const items: vscode.CompletionItem[] = [];

    for (const entry of this.registry.getAll()) {
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
