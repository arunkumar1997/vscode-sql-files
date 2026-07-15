export type FileType = "csv" | "json" | "parquet" | "text";

export type ExportFormat = "csv" | "parquet";

/** Lifecycle state of a table in the registry. */
export type TableLoadState = "configured" | "loading" | "loaded" | "error";

/** Origin of a table entry: from config file or added ad-hoc at runtime. */
export type TableOrigin = "config" | "adhoc";

export interface TableEntry {
  name: string;
  filePath: string;       // runtime-resolved local path (or s3:// for non-downloaded entries)
  fileType: FileType;
  isS3: boolean;
  sourceUri?: string;     // original s3:// URI shown in UI
  columns?: ColumnInfo[];
  /** Enable DuckDB's extraction of key=value directory segments as columns. */
  hivePartitioning?: boolean;
  /** Current load state. Defaults to 'loaded' for backward compat with ad-hoc adds. */
  loadState?: TableLoadState;
  /** Human-readable error message when loadState is 'error'. */
  loadError?: string;
  /** Origin: "config" entries came from .filesql/config.json, "adhoc" from user actions. Default adhoc. */
  origin?: TableOrigin;
  /** Declarative source from config file — preserved separately from runtime filePath. */
  source?: string;
}

/**
 * Subset of TableEntry persisted in .filesql/config.json.
 * Contains only declarative metadata — no credentials, runtime state, or temp paths.
 */
export interface ConfigTableEntry {
  name: string;
  /** Workspace-relative local path or s3:// URI. */
  source: string;
  fileType: FileType;
  hivePartitioning?: boolean;
}

export interface ColumnInfo {
  name: string;
  type: string;
}

export interface QueryResult {
  columns: ColumnInfo[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

export interface WebviewMessage {
  type: "runQuery" | "exportResults" | "tablesChanged" | "queryResult" | "queryError" | "exportResult" | "exportError" | "ready";
  payload?: unknown;
}

export interface RunQueryMessage extends WebviewMessage {
  type: "runQuery";
  payload: { sql: string };
}

export interface ExportResultsMessage extends WebviewMessage {
  type: "exportResults";
  payload: { tabId: string; format: string };
}

export interface TablesChangedMessage extends WebviewMessage {
  type: "tablesChanged";
  payload: { tables: TableEntry[] };
}

export interface QueryResultMessage extends WebviewMessage {
  type: "queryResult";
  payload: QueryResult;
}

export interface QueryErrorMessage extends WebviewMessage {
  type: "queryError";
  payload: { message: string };
}

export interface ExportResultMessage extends WebviewMessage {
  type: "exportResult";
  payload: { path: string; format: ExportFormat };
}

export interface ExportErrorMessage extends WebviewMessage {
  type: "exportError";
  payload: { message: string };
}
