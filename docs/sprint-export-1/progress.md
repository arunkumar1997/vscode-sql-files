# Sprint Export-1 Progress

| Phase | Owner | Status | Evidence |
| --- | --- | --- | --- |
| 0. Prioritization and plan | Remy | Done | Team debate completed; issue #4 selected |
| 1. Engine contract | Sage | Done | RED 3 failures → GREEN 20/20 focused, full suite 140/140 |
| 2. Extension/webview flow | Nova + Milo | Blocked | Waits for Phase 1 API contract |
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
