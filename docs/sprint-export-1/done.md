# Sprint Export-1 — QA Sign-off

**QA Engineer:** Ivy
**Date:** 2026-07-15
**Branch:** `feature/export-results`
**Commits reviewed:** `511cc8b` (Phase 1 engine), `48c2b93` (Phase 2 UI/handler)

## Test Results

| Suite | Count | Pass | Fail |
| --- | --- | --- | --- |
| Unit (vitest) | 113 | 113 | 0 |
| Integration (vitest) | 56 | 56 | 0 |
| E2E (xvfb + @vscode/test-electron) | 7 | 7 | 0 |
| **Total** | **176** | **176** | **0** |

## Defect Found and Fixed

### DEF-1: Malformed `exportResults` payload crashes handler (severity: minor)

**Path:** `src/commands/openQueryEditor.ts:93`
**Root cause:** Destructuring `msg.payload as { tabId: string; format: string }` without null/type guard. A webview message with missing, null, or wrong-typed payload crashes the extension host with `TypeError: Cannot destructure property 'tabId' of undefined/null`.
**RED evidence:** 2 tests failed — `malformed exportResults with missing payload` and `malformed exportResults with null payload` both threw `TypeError`.
**Fix:** Added guard before destructuring: validates `payload` exists and `tabId`/`format` are strings. Posts `exportError` on malformed input.
**GREEN evidence:** All 17 handler tests pass after fix.
**Regression risk:** None — only adds an early-return guard; all existing message paths unchanged.

## Coverage by Requirement

### Custom COPY passthrough (user SQL, no dialog, no maxRows cap)
- [x] Custom COPY with non-default options (DELIMITER, QUOTE, etc.) writes all rows beyond maxRows — engine test + handler test
- [x] Custom COPY failure reports `queryError`, no success masquerade — handler test
- [x] COPY statement classification uses DuckDB-native `prepare().statementType`, not keyword heuristic
- [x] Multi-statement rejection through webview bridge — handler test

### Convenience CSV/Parquet export (toolbar → save dialog → full re-execution)
- [x] CSV export: correct dialog filters, full data written, `exportResult` posted
- [x] Parquet export: correct dialog filters, valid Parquet file, `exportResult` posted
- [x] Parquet readback through DuckDB confirms row count and column structure
- [x] Cancellation (no URI): no write, no error
- [x] Export failure: `exportError` posted, no misleading `exportResult`
- [x] Per-tab SQL isolation: each tab exports its own last query
- [x] Export uses original SQL, not the LIMIT-wrapped display query
- [x] Export re-executes full query (not capped to maxRows)

### Message boundary validation
- [x] Invalid format ("xlsx") rejected before dialog opens
- [x] Missing payload does not crash — posts `exportError`
- [x] Null payload does not crash — posts `exportError`
- [x] Wrong-typed payload (tabId=number, format=boolean) posts `exportError`
- [x] Tab with no prior query posts "No query to export" error

### CSV edge values
- [x] Commas, double-quotes, newlines, NULLs, and Unicode (日本語, émojis 🎉) export and DuckDB round-trip correctly

### Parquet type fidelity
- [x] Integer, float, string, boolean values survive export and readback

### Regression
- [x] Existing SELECT truncation at maxRows preserved
- [x] CTE and comment-prefixed queries remain row-producing
- [x] EXPLAIN, DESCRIBE, SHOW, VALUES all bounded correctly
- [x] COMMENT ON and other non-row statements execute directly
- [x] E2E: activation, query, addPath, clearTables, openQueryEditor all pass

## Files Changed

| File | Change |
| --- | --- |
| `src/commands/openQueryEditor.ts` | Payload validation guard on `exportResults` handler |
| `test/integration/command-exportResults.test.ts` | +10 new tests (malformed payloads, COPY passthrough, failure paths, per-tab isolation, multi-statement, Parquet readback) |
| `test/integration/engine-export.test.ts` | +2 new tests (CSV edge values, Parquet type readback) |
| `docs/sprint-export-1/progress.md` | Updated Phase 3 status |

## Residual Risks

1. **Native save dialog:** Not clickable in E2E automation — covered at integration handler level (mock `showSaveDialog`). Acceptable gap.
2. **Issue #8 (rename collision):** Not in scope — deferred per plan.
3. **`runQuery` handler** has the same destructuring-without-guard pattern as the fixed `exportResults` handler. Not a blocker for this sprint but should be addressed.

## Sign-off

✅ **PASS** — No blockers. All 176 tests pass. One minor defect found and fixed with TDD evidence.
