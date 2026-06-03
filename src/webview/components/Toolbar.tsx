import React from "react";
import { QueryResult } from "../../types";

interface Props {
  onRun: () => void;
  running: boolean;
  result: QueryResult | null;
}

export function Toolbar({ onRun, running, result }: Props): JSX.Element {
  return (
    <div className="toolbar">
      <button
        onClick={onRun}
        disabled={running}
        title="Run query or selection (Ctrl+Enter)"
      >
        {running ? "Running…" : "▶ Run"}
      </button>
      <span className="toolbar-hint">
        Ctrl+Enter · select text to run partial query
      </span>
      {result && (
        <>
          <span className="row-count">
            {result.rowCount} row{result.rowCount !== 1 ? "s" : ""}
          </span>
          {result.truncated && (
            <span className="truncated">⚠ results truncated</span>
          )}
        </>
      )}
    </div>
  );
}
