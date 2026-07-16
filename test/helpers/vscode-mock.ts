import { vi } from "vitest";
import path from "path";

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
  joinPath: (base: { path: string; toString: () => string }, ...segments: string[]) => {
    const joined = path.join(base.path, ...segments);
    return { scheme: "file", fsPath: joined, path: joined, toString: () => `file://${joined}` };
  },
};

// --- window ---
export const window = {
  showInputBox: vi.fn(),
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  showQuickPick: vi.fn(),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  withProgress: vi.fn(async (_options: unknown, task: (progress: { report: (...a: unknown[]) => void }) => Promise<unknown>) => {
    return task({ report: vi.fn() });
  }),
  createOutputChannel: vi.fn(() => ({
    appendLine: vi.fn(),
    append: vi.fn(),
    show: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
  })),
  createWebviewPanel: vi.fn(),
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
  fs: {
    readFile: vi.fn().mockRejectedValue(Object.assign(new Error("File not found"), { code: "FileNotFound" })),
    readDirectory: vi.fn().mockRejectedValue(Object.assign(new Error("Directory not found"), { code: "FileNotFound" })),
    writeFile: vi.fn().mockResolvedValue(undefined),
    createDirectory: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockRejectedValue(new Error("Not implemented")),
  },
};

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

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

// --- ThemeColor ---
export class ThemeColor {
  id: string;
  constructor(id: string) {
    this.id = id;
  }
}

// --- ThemeIcon ---
export class ThemeIcon {
  id: string;
  color?: ThemeColor;
  constructor(id: string, color?: ThemeColor) {
    this.id = id;
    this.color = color;
  }
}

// --- ProgressLocation ---
export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

// --- ViewColumn ---
export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3,
}

// --- CompletionItem ---
export class CompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string;
  constructor(label: string, kind?: number) {
    this.label = label;
    this.kind = kind;
  }
}

// --- CompletionItemKind ---
export enum CompletionItemKind {
  Text = 0,
  Method = 1,
  Function = 2,
  Constructor = 3,
  Field = 4,
  Variable = 5,
  Class = 6,
}

// --- Position ---
export class Position {
  line: number;
  character: number;
  constructor(line: number, character: number) {
    this.line = line;
    this.character = character;
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

// --- Typed mock helpers for tests ---
export interface MockWorkspaceFs {
  readFile: ReturnType<typeof vi.fn>;
  readDirectory: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  createDirectory: ReturnType<typeof vi.fn>;
  rename: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

/** Replace workspace.fs with a typed mock. Returns the mock for assertion. */
export function mockWorkspaceFs(overrides?: Partial<MockWorkspaceFs>): MockWorkspaceFs {
  const mock: MockWorkspaceFs = {
    readFile: vi.fn().mockRejectedValue(Object.assign(new Error("File not found"), { code: "FileNotFound" })),
    readDirectory: vi.fn().mockResolvedValue([]),
    writeFile: vi.fn().mockResolvedValue(undefined),
    createDirectory: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  (workspace as { fs: MockWorkspaceFs }).fs = mock;
  return mock;
}
