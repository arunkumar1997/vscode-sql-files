export type FileType = "csv" | "json" | "parquet" | "text";

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
  type: "runQuery" | "tablesChanged" | "queryResult" | "queryError" | "ready";
  payload?: unknown;
}

export interface RunQueryMessage extends WebviewMessage {
  type: "runQuery";
  payload: { sql: string };
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
