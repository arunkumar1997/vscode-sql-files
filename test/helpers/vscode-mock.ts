import { vi } from "vitest";

// --- EventEmitter ---
export class EventEmitter<T = void> {
  private listeners: Array<(e: T) => void> = [];

  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => this.listeners.splice(this.listeners.indexOf(listener), 1) };
  };

  fire(data: T): void {
    for (const fn of this.listeners) {
      fn(data);
    }
  }

  dispose(): void {
    this.listeners = [];
  }
}

// --- Uri ---
export const Uri = {
  file: (p: string) => ({ scheme: "file", fsPath: p, path: p, toString: () => `file://${p}` }),
  parse: (s: string) => {
    try {
      const u = new URL(s);
      return { scheme: u.protocol.replace(":", ""), fsPath: u.pathname, path: u.pathname, toString: () => s };
    } catch {
      return { scheme: "", fsPath: s, path: s, toString: () => s };
    }
  },
};

// --- window ---
export const window = {
  showInputBox: vi.fn(),
  showOpenDialog: vi.fn(),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  createOutputChannel: vi.fn(() => ({
    appendLine: vi.fn(),
    append: vi.fn(),
    show: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
  })),
};

// --- workspace ---
export const workspace = {
  getConfiguration: vi.fn(() => ({
    get: vi.fn((key: string, defaultValue?: unknown) => defaultValue),
    update: vi.fn(),
    has: vi.fn(() => false),
    inspect: vi.fn(),
  })),
  workspaceFolders: [],
  onDidChangeConfiguration: vi.fn(),
};

// --- commands ---
export const commands = {
  registerCommand: vi.fn(),
  executeCommand: vi.fn(),
};

// --- TreeItem ---
export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  label?: string;
  collapsibleState?: TreeItemCollapsibleState;
  iconPath?: unknown;
  contextValue?: string;
  description?: string;
  tooltip?: string;

  constructor(label: string, collapsibleState?: TreeItemCollapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

// --- ThemeIcon ---
export class ThemeIcon {
  id: string;
  constructor(id: string) {
    this.id = id;
  }
}

// --- Memento (for TableRegistry persistence tests) ---
export class MockMemento {
  private store = new Map<string, unknown>();
  get<T>(key: string, defaultValue?: T): T {
    return (this.store.get(key) as T) ?? (defaultValue as T);
  }
  update(key: string, value: unknown): Thenable<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }
}
