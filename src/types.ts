export type FileType = "csv" | "json" | "parquet" | "text";

export type ExportFormat = "csv" | "parquet";

export interface TableEntry {
  name: string;
  filePath: string;       // local path (or s3:// for non-downloaded entries)
  fileType: FileType;
  isS3: boolean;
  sourceUri?: string;     // original s3:// URI shown in UI
  columns?: ColumnInfo[];
  /** Enable DuckDB's extraction of key=value directory segments as columns. */
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
