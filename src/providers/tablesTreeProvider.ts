import * as vscode from "vscode";
import { TableEntry } from "../types";
import { TableRegistry } from "../tableRegistry";

type TreeNode = TableNode | ColumnNode;

class TableNode extends vscode.TreeItem {
  readonly contextValue = "table";
  constructor(public readonly entry: TableEntry) {
    super(entry.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.tooltip = entry.sourceUri ?? entry.filePath;
    this.iconPath = new vscode.ThemeIcon(entry.isS3 ? "cloud" : "database");
    this.description = entry.isS3 ? "s3" : entry.fileType;
  }
}

class ColumnNode extends vscode.TreeItem {
  readonly contextValue = "column";
  constructor(name: string, type: string) {
    super(name, vscode.TreeItemCollapsibleState.None);
    this.description = type;
    this.iconPath = new vscode.ThemeIcon("symbol-field");
  }
}

export class TablesTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    TreeNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly registry: TableRegistry) {
    registry.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      return this.registry.getAll().map((e) => new TableNode(e));
    }
    if (element instanceof TableNode) {
      return (element.entry.columns ?? []).map(
        (c) => new ColumnNode(c.name, c.type),
      );
    }
    return [];
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
