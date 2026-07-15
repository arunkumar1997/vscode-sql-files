# Sprint Export-1 Plan

**Producer:** Remy
**GitHub issue:** [#4 Export query results to Parquet / CSV](https://github.com/arunkumar1997/vscode-sql-files/issues/4)
**Method:** Strict TDD: RED -> GREEN -> REFACTOR at every phase
**Branch:** `feature/export-results`

## Priority Decision

Open-issue ranking by direct end-user value:

1. **#4 Export results** - completes the core query workflow; currently users cannot reuse a full result set.
2. **#8 Rename collision** - data-integrity invariant, but the current UI already blocks the collision.
3. **#5 Shared configs and saved queries** - valuable for teams, but broad and unresolved around credentials.
4. **#6 S3 range reads** - important for large datasets, but narrower audience and costly infrastructure validation.

### Team Debate

- **Kira/Milo (Product/UX):** #4 is the largest visible workflow gap. Users can inspect results but cannot take them elsewhere.
- **Ivy (QA):** #8 is the safest TDD target because it is deterministic and already has a test documenting the bug.
- **Nova/Sage (Engineering):** #4 has greater product value, but raw `COPY` support touches the central query path and must not rely on a naive SQL-prefix heuristic.
- **Remy decision:** Ship #4 with strict phase gates. Keep #8 isolated for a later bug-fix change; do not mix unrelated production changes into this sprint.

## Scope

Deliver both acceptance paths from issue #4:

1. Export the current result set from the webview to CSV or Parquet through a native save dialog.
2. Allow a user-authored DuckDB `COPY ... TO ...` statement to execute without being wrapped in `SELECT * FROM (...) LIMIT N`.

## Architecture

```text
Toolbar export action
  -> webview message: exportResults(format)
  -> extension save dialog
  -> DuckDBEngine.exportQuery(sql, destination, format)
  -> COPY (<query>) TO '<path>' (FORMAT CSV|PARQUET)
  -> exportResult/exportError message

Raw query editor COPY statement
  -> DuckDBEngine.executeQuery(sql)
  -> classify statement using DuckDB preparation/execution behavior
  -> row-producing query: preserve max-row wrapper
  -> non-row statement: execute directly and return an empty result
```

The implementation must use structured message types and safe SQL-literal/path escaping. Do not serialize CSV manually in the webview and do not infer statement type with a brittle `startsWith('SELECT')` rule.

## Phase 1 - Engine Contract (Sage)

### RED

Add focused integration tests first:

- Existing SELECT queries still enforce `maxResultRows` and truncation.
- CTE queries beginning with comments or `WITH` remain row-producing and bounded.
- Raw `COPY (SELECT ...) TO ... (FORMAT CSV)` creates a valid CSV file.
- Raw `COPY (SELECT ...) TO ... (FORMAT PARQUET)` creates a queryable Parquet file.
- Destination paths containing a single quote are escaped correctly.
- Unsupported/malformed statements return the existing error behavior.

Capture the failing output in `progress.md` before production changes.

### GREEN

Make the smallest engine/API change needed for the tests. Preserve all existing query behavior and public contracts where possible.

### REFACTOR

Extract statement/export helpers only when they remove duplication or centralize escaping. Run unit + integration suites.

## Phase 2 - Extension/Webview Flow (Nova + Milo)

### RED

Add tests before implementation:

- Message contract accepts only `csv` and `parquet` formats.
- Export handler opens `showSaveDialog` with the correct filter and extension.
- Canceling the dialog performs no write and reports no error.
- Successful export posts `exportResult`; failure posts `exportError`.
- Toolbar exposes CSV and Parquet export actions only when a successful query result exists.
- Exporting a truncated result warns the user that export reruns the original SQL and exports the full result, not only visible rows.

### GREEN

Implement the typed bridge, save dialog, and compact toolbar menu/button using existing VS Code visual conventions.

### REFACTOR

Keep filesystem and DuckDB work in the extension host. Keep the webview responsible only for intent and status.

## Phase 3 - QA (Ivy)

- Run all unit and integration tests.
- Run E2E activation/query regression tests.
- Add an E2E export test for CSV and Parquet when native save-dialog automation can be deterministic; otherwise test the exported extension API/handler and record the UI-dialog gap.
- Verify CSV with commas, quotes, newlines, nulls, and Unicode.
- Verify Parquet by reading it back through DuckDB.
- Verify no partial file remains after a failed export.
- File newly discovered bugs as GitHub issues; do not hide them in sprint notes.

## Acceptance Criteria

- Current query can be exported as CSV and Parquet from the results toolbar.
- Native save dialog uses the selected format and a sensible default filename.
- Export writes the full query result, even when the visible grid is truncated, with a clear warning.
- Raw `COPY ... TO ...` statements run from the query editor.
- Existing SELECT, CTE, limit, error, unit, integration, and E2E tests remain green.
- No network calls and no writes outside user-selected paths or test temp directories.
- Commit closes the issue using `Fixes #4`.

## Merge Gate

The producer merges only after:

1. RED evidence exists for each phase.
2. Focused GREEN checks pass.
3. Full `npm test` passes under `xvfb-run`.
4. Ivy signs off with no open blocker.
