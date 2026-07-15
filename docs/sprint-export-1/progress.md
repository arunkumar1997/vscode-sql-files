# Sprint Export-1 Progress

| Phase | Owner | Status | Evidence |
| --- | --- | --- | --- |
| 0. Prioritization and plan | Remy | Done | Team debate completed; issue #4 selected |
| 1. Engine contract | Sage | Done | RED 3 failures → GREEN 20/20 focused, full suite 140/140 |
| 2. Extension/webview flow | Nova + Milo | Done | RED 6 failures → GREEN 7/7 focused, full suite 157/157 |
| 3. QA sign-off | Ivy | Blocked | Waits for implementation |

## TDD Log

### Phase 1 — Engine contract (Sage)

**RED command:**
```
npx vitest run --config vitest.integration.config.ts test/integration/engine-export.test.ts
```

**RED failures (3/20, 17 existing-behavior tests passed immediately):**
- `COMMENT ON executes correctly (not in keyword allowlist)`: `Parser Error: syntax error at or near "ON"` — keyword "COMMENT" not in allowlist, wrapped in SELECT * FROM (...)
- `EXPLAIN returns output bounded by maxRows`: `Parser Error: syntax error at or near "SELECT"` — EXPLAIN cannot be subqueried
- `rejects multi-statement input with a clear error`: expected `/multiple statements/i` but got generic parser error — no explicit multi-statement rejection

**GREEN changes:**
- `src/duckdbEngine.ts`:
  - Replaced `isNonRowStatement()` keyword allowlist with DuckDB-native `conn.prepare(sql).statementType` classification
  - Added `conn.extractStatements(sql)` to detect and reject multi-statement input before execution
  - Three classification paths:
    1. **Wrappable row-producing** (StatementType.SELECT): wrapped in `SELECT * FROM (...) LIMIT N` — covers SELECT, VALUES, SHOW, DESCRIBE, PRAGMA
    2. **Direct row-producing** (StatementType.EXPLAIN, CALL, RELATION): executed directly, result truncated to maxRows
    3. **Non-row** (everything else: COPY, CREATE, DROP, ALTER, INSERT, UPDATE, DELETE, SET, LOAD, ATTACH, DETACH, EXPORT, VACUUM, COMMENT ON, etc.): executed directly, returns empty QueryResult
  - Extracted `executeAndSerialize()` private method to share serialization logic between wrappable and direct paths
  - Imported `StatementType` enum from `@duckdb/node-api`

**GREEN result:** 20/20 focused tests pass.

**Full suite:** 103 unit + 37 integration = 140/140 pass. Compile and build clean.

### API Contract

```typescript
// Explicit export: writes full (unbounded) result to file
async exportQuery(sql: string, destination: string, format: ExportFormat): Promise<void>

// executeQuery: uses DuckDB prepared-statement metadata to classify:
// - SELECT/VALUES/SHOW/DESCRIBE/PRAGMA: bounded by maxRows via LIMIT wrapping
// - EXPLAIN/CALL: bounded by maxRows via result-array truncation
// - COPY/CREATE/DROP/ALTER/etc: executed directly, returns empty QueryResult
// - Multiple statements: rejected with clear error message
// User-authored COPY passes through with all DuckDB options (DELIMITER, QUOTE, etc.)
async executeQuery(sql: string, maxRows: number): Promise<QueryResult>
```

### Design — DuckDB-native statement classification

Statement classification now uses `conn.prepare(sql).statementType` from the `@duckdb/node-api`
prepared statement API. This is a DuckDB-native mechanism that:

1. **Handles all current and future DuckDB statement types** — no keyword list to maintain
2. **Correctly classifies edge cases** the keyword approach missed:
   - `COMMENT ON` → type=ALTER(9), keyword was "COMMENT" not in list → now works
   - `EXPLAIN` → type=EXPLAIN(4), can't be subqueried → now runs directly
   - `PRAGMA version` → DuckDB rewrites to type=SELECT(1) → correctly treated as row-producing
3. **Does not execute the statement** — `prepare()` only parses, so no double-execution risk
4. **Multi-statement detection** uses `conn.extractStatements()` which returns statement count, explicitly rejecting `count > 1` with a clear error

DuckDB API limitation: `columnCount` is unreliable for classification (returns 1 even for CREATE/COPY). `statementType` is the correct discriminator.

## Issues

- [#4](https://github.com/arunkumar1997/vscode-sql-files/issues/4) - sprint scope
- [#8](https://github.com/arunkumar1997/vscode-sql-files/issues/8) - deferred; do not mix into this feature branch

### Phase 2 — Extension/Webview flow (Nova + Milo)

**RED command:**
```
npx vitest run --config vitest.integration.config.ts test/integration/command-exportResults.test.ts
npx vitest run test/unit/exportHelpers.test.ts
```

**RED failures (6/7 integration, 1/1 unit suite):**
- Integration: `showSaveDialog` not defined on vscode mock → `TypeError: Cannot read properties of undefined`
- Integration: `exportResults` message type not handled → no `exportResult`/`exportError` posted
- Integration: format validation not implemented → no `exportError` for invalid format
- Integration: `tabSqlMap` not tracking original SQL per tab → no SQL for export
- Unit: `exportHelpers` module not found → `Cannot find module '../../src/webview/exportHelpers'`

**GREEN changes:**
- `test/helpers/vscode-mock.ts`: added `showSaveDialog: vi.fn()` to window mock
- `src/types.ts`: added `ExportResultsMessage`, `ExportResultMessage`, `ExportErrorMessage` types; extended `WebviewMessage.type` union
- `src/commands/openQueryEditor.ts`:
  - Added `tabSqlMap: Map<string, string>` to track original SQL per tab
  - Stores SQL in `tabSqlMap` on every `runQuery` before execution
  - Added `exportResults` message handler: validates format → shows save dialog → calls `engine.exportQuery()` → posts `exportResult`/`exportError`
  - Format validation rejects unsupported formats before opening dialog
  - Cancellation (no URI from dialog) returns silently without error
  - Clears `tabSqlMap` on panel dispose
- `src/webview/exportHelpers.ts`: new pure module with `isExportEnabled()`, `isSuccessStatus()`, `formatExportStatus()` — no DOM/Node deps, testable in both environments
- `src/webview/components/Toolbar.tsx`: added "Export CSV" and "Export Parquet" buttons; disabled when no row result, running, or exporting; truncated-result tooltip explains full-query re-execution
- `src/webview/App.tsx`:
  - Extended `TabState` with `exporting`, `exportStatus`, `exportError` fields (per-tab isolation)
  - Added `handleExport()` → posts `exportResults` message
  - Added `exportResult`/`exportError` message handlers
  - Non-row result (COPY, CREATE, etc.) shows "Statement executed successfully" banner instead of misleading "0 rows"
- `src/webview/styles.css`: added `.toolbar-separator`, `.toolbar-export-btn`, `.export-status`, `.export-error`, `.success-banner` styles using existing VS Code CSS variables

**GREEN result:** 7/7 focused integration tests pass, 10/10 unit tests pass.

**Full suite:** 113 unit + 44 integration = 157/157 pass. Webview typecheck (`tsc -p tsconfig.webview.json --noEmit`), compile, and build clean.

### UX Behavior

1. **Export buttons** appear in the toolbar after a successful row-producing query. Two separate buttons: "Export CSV" and "Export Parquet". Buttons are disabled (greyed out, 35% opacity) when:
   - No result yet
   - Query is running
   - Export is in progress
   - Result is a non-row statement (0 rows, 0 columns)

2. **Truncated results tooltip**: When results are truncated, export buttons show tooltip: "Export reruns the original query and exports all rows, not only the visible truncated subset."

3. **Export flow**: Click button → extension opens native save dialog with format-specific filter and default extension → engine writes full result via `COPY` → toolbar shows green "Exported as CSV: filename.csv" status.

4. **Error handling**: Export failures show inline red error text in toolbar. Invalid format rejected before dialog opens.

5. **Non-row commands** (COPY, CREATE, DROP, etc.): Results panel shows green "Statement executed successfully" banner instead of misleading "Query returned 0 rows".

6. **Custom COPY passthrough**: User-authored `COPY (SELECT ...) TO '...' (FORMAT CSV, HEADER)` passes through `runQuery` unchanged via Phase 1 engine classification. No maxRows wrapping. Success shows "Statement executed successfully" banner. File is written by DuckDB directly.

### Deviations

- None. All plan requirements met.
