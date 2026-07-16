import * as vscode from "vscode";
import { TableEntry } from "../types";
import { TableRegistry } from "../tableRegistry";

type TreeNode = TableNode | ColumnNode;

class TableNode extends vscode.TreeItem {
  readonly contextValue: string;
  constructor(public readonly entry: TableEntry) {
    const isExpandable =
      entry.loadState === "loaded" || entry.loadState === undefined;
    super(
      entry.name,
      isExpandable
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    this.tooltip = entry.loadError ?? entry.sourceUri ?? entry.filePath;
    // State-dependent rendering
    switch (entry.loadState) {
      case "configured":
        this.iconPath = new vscode.ThemeIcon(
          entry.isS3 ? "cloud" : "database",
          new vscode.ThemeColor("disabledForeground"),
        );
        this.description = "Not loaded";
        this.contextValue = "table.configured";
        break;
      case "loading":
        this.iconPath = new vscode.ThemeIcon("sync~spin");
        this.description = "Loading…";
        this.contextValue = "table.loading";
        break;
      case "error":
        this.iconPath = new vscode.ThemeIcon(
          "error",
          new vscode.ThemeColor("errorForeground"),
        );
        this.description = "Error";
        this.contextValue = "table.error";
        break;
      default:
        // loaded or undefined (backward compat)
        this.iconPath = new vscode.ThemeIcon(entry.isS3 ? "cloud" : "database");
        this.description = entry.isS3 ? "s3" : entry.fileType;
        this.contextValue = "table";
        break;
    }
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
