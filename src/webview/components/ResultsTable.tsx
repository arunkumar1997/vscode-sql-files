import React, { useState } from "react";
import { QueryResult } from "../../types";

interface Props {
  result: QueryResult | null;
}

export function ResultsTable({ result }: Props): JSX.Element {
  const [toast, setToast] = useState<string | null>(null);

  function copyText(text: string) {
    navigator.clipboard.writeText(text);
    setToast(`Copied: ${text}`);
    setTimeout(() => setToast(null), 1500);
  }

  function handleClick(e: React.MouseEvent, text: string) {
    if (e.altKey) {
      e.preventDefault();
      copyText(text);
    }
  }

  if (!result) {
    return <div className="empty-state">Run a query to see results</div>;
  }

  if (result.rows.length === 0) {
    return <div className="empty-state">Query returned 0 rows</div>;
  }

  return (
    <div className="results-wrapper">
      <table className="results-table">
        <thead>
          <tr>
            <th className="row-num">#</th>
            {result.columns.map((c) => (
              <th
                key={c.name}
                title={`${c.type} — Alt+click to copy`}
                className="copyable"
                onClick={(e) => handleClick(e, c.name)}
              >
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i}>
              <td className="row-num">{i + 1}</td>
              {result.columns.map((c) => (
                <td
                  key={c.name}
                  title="Alt+click to copy"
                  onClick={(e) => handleClick(e, String(row[c.name] ?? ""))}
                >
                  {String(row[c.name] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {toast && <div className="copy-toast">{toast}</div>}
    </div>
  );
}
