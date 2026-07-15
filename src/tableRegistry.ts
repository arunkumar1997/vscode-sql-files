import * as vscode from "vscode";
import { TableEntry } from "./types";

const STORAGE_KEY = "fileSql.registeredTables";

export class TableRegistry {
  private tables = new Map<string, TableEntry>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private memento: vscode.Memento | undefined;

  /** Bind a workspace-state memento for persistence. */
  setStorage(memento: vscode.Memento): void {
    this.memento = memento;
  }

  add(entry: TableEntry): void {
    this.tables.set(entry.name, entry);
    this._onDidChange.fire();
    this.persist();
  }

  remove(name: string): boolean {
    const deleted = this.tables.delete(name);
    if (deleted) {
      this._onDidChange.fire();
      this.persist();
    }
    return deleted;
  }

  get(name: string): TableEntry | undefined {
    return this.tables.get(name);
  }

  getAll(): TableEntry[] {
    return Array.from(this.tables.values());
  }

  has(name: string): boolean {
    return this.tables.has(name);
  }

  clear(): void {
    this.tables.clear();
    this._onDidChange.fire();
    this.persist();
  }

  rename(oldName: string, newName: string): boolean {
    if (oldName === newName) {
      return this.tables.has(oldName);
    }
    const entry = this.tables.get(oldName);
    if (!entry) {
      return false;
    }
    if (this.tables.has(newName)) {
      throw new Error(`Table "${newName}" already exists`);
    }
    this.tables.delete(oldName);
    entry.name = newName;
    this.tables.set(newName, entry);
    this._onDidChange.fire();
    this.persist();
    return true;
  }

  updateColumns(name: string, columns: TableEntry["columns"]): void {
    const entry = this.tables.get(name);
    if (entry) {
      entry.columns = columns;
      this._onDidChange.fire();
      this.persist();
    }
  }

  /** Load persisted entries into the in-memory map (does NOT register with engine). */
  loadFromStorage(): TableEntry[] {
    if (!this.memento) {
      return [];
    }
    const stored = this.memento.get<TableEntry[]>(STORAGE_KEY, []);
    for (const entry of stored) {
      this.tables.set(entry.name, entry);
    }
    if (stored.length > 0) {
      this._onDidChange.fire();
    }
    return stored;
  }

  private persist(): void {
    if (!this.memento) {
      return;
    }
    this.memento.update(STORAGE_KEY, Array.from(this.tables.values()));
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
