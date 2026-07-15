import React from "react";
import { ExportFormat, QueryResult } from "../../types";
import { isExportEnabled } from "../exportHelpers";

interface Props {
  onRun: () => void;
  onExport: (format: ExportFormat) => void;
  running: boolean;
  exporting: boolean;
  result: QueryResult | null;
  exportStatus: string | null;
  exportError: string | null;
}

export function Toolbar({
  onRun,
  onExport,
  running,
  exporting,
  result,
  exportStatus,
  exportError,
}: Props): JSX.Element {
  const canExport = isExportEnabled(result, running, exporting);
  const truncatedTooltip = result?.truncated
    ? "Export reruns the original query and exports all rows, not only the visible truncated subset."
    : undefined;

  return (
    <div className="toolbar">
      <button
        onClick={onRun}
        disabled={running}
        title="Run query or selection (Ctrl+Enter)"
      >
        {running ? "Running\u2026" : "\u25B6 Run"}
      </button>
      <span className="toolbar-hint">Ctrl+Enter</span>

      <span className="toolbar-separator" />

      <button
        onClick={() => onExport("csv")}
        disabled={!canExport}
        title={truncatedTooltip ?? "Export results as CSV"}
        className="toolbar-export-btn"
      >
        {exporting ? "Exporting\u2026" : "Export CSV"}
      </button>
      <button
        onClick={() => onExport("parquet")}
        disabled={!canExport}
        title={truncatedTooltip ?? "Export results as Parquet"}
        className="toolbar-export-btn"
      >
        Export Parquet
      </button>

      {result && (
        <>
          <span className="row-count">
            {result.rowCount} row{result.rowCount !== 1 ? "s" : ""}
          </span>
          {result.truncated && (
            <span className="truncated" title={truncatedTooltip}>
              results truncated
            </span>
          )}
        </>
      )}

      {exportStatus && <span className="export-status">{exportStatus}</span>}
      {exportError && <span className="export-error">{exportError}</span>}
    </div>
  );
}
