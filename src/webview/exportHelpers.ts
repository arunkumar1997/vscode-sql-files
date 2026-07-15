import { ExportFormat, QueryResult } from "../types";

/** Whether export buttons should be enabled for the current tab state. */
export function isExportEnabled(
  result: QueryResult | null,
  running: boolean,
  exporting: boolean,
): boolean {
  if (!result || running || exporting) return false;
  return result.rowCount > 0 && result.columns.length > 0;
}

/** Whether the result represents a successful non-row statement (COPY, CREATE, etc.). */
export function isSuccessStatus(result: QueryResult | null): boolean {
  if (!result) return false;
  return result.rowCount === 0 && result.columns.length === 0;
}

/** Human-readable export status text. */
export function formatExportStatus(format: ExportFormat, filePath: string): string {
  const label = format === "csv" ? "CSV" : "Parquet";
  // Extract filename without Node path module (runs in webview)
  const filename = filePath.split(/[/\\]/).pop() ?? filePath;
  return `Exported as ${label}: ${filename}`;
}
