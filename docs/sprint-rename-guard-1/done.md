# Sprint Rename-Guard-1 — QA Sign-Off

**Issue:** [#8 TableRegistry.rename() silently overwrites existing table with same name](https://github.com/arunkumar1997/vscode-sql-files/issues/8)
**QA Engineer:** Ivy
**Date:** 2026-07-15
**Verdict:** ✅ PASS — No blockers

## Test Results

| Suite | Count | Result |
|-------|-------|--------|
| Unit | 115/115 | ✅ Pass |
| Integration | 59/59 | ✅ Pass |
| Compile (`tsc --noEmit`) | 0 errors | ✅ Pass |
| Lint (`eslint src`) | 0 errors | ✅ Pass |
| E2E | 7/7 | ✅ Pass |

## Commands Run

```bash
npm run test:unit          # 115 pass, 297ms
npm run test:integration   # 59 pass, 1.26s
npx tsc --noEmit           # clean
npm run lint               # clean
npm run pretest:e2e && npm run test:e2e  # 7 pass, 3s
```

## Edge Cases Verified

| Scenario | Layer | Result |
|----------|-------|--------|
| `rename('a', 'a')` existing entry | Registry unit | No-op, returns `true`, no event fired, no persist |
| `rename('a', 'a')` nonexistent entry | Registry unit | Returns `false`, no event fired |
| `rename('a', 'b')` where `b` exists | Registry unit | Throws `Error("Table \"b\" already exists")`, both entries intact with original filePaths |
| `rename('ghost', 'x')` | Registry unit | Returns `false`, no event |
| Command: rename to existing name (bypass UI) | Integration | `showErrorMessage` called with "already exists", engine NOT called, registry intact |
| Command: rename to same name | Integration | Command returns early (`newName.trim() === oldName`), engine NOT called |
| Command: engine.renameTable fails after registry.rename succeeds | Integration | Rollback restores `oldName`, removes `newName`, `entry.name` restored, `showErrorMessage` called |

## Changes Audited

**`src/tableRegistry.ts` — `rename()`** (+6 lines)
- `oldName === newName` → returns `this.tables.has(oldName)` — correct no-op semantic
- Collision check before any mutation → throw prevents data loss
- Existing "source not found" path unchanged

**`src/commands/clearTables.ts` — `renameTable()`**
- Records whether the registry rename completed before calling the engine
- When `registry.rename()` throws on collision, rollback is skipped because no state changed
- When `engine.renameTable()` throws, the completed registry rename is rolled back
- `showErrorMessage` fires in both paths

**Tests added/modified:**
- Unit: 3 tests (1 modified from "potential bug" doc → assertion flip, 2 new)
- Integration: 3 tests (collision, engine-failure-rollback, same-name no-op)

## Test Added by QA

Added `"rolls back registry rename when engine.renameTable fails"` in `test/integration/command-clearTables.test.ts`. This test was missing — it covers the engine-failure path where `registry.rename()` succeeds, then `engine.renameTable()` throws, and the catch block must roll back registry state. Test was GREEN immediately (no production defect found).

## Post-Sign-Off Follow-Up

The previously noted malformed `runQuery` payload vulnerability is resolved. The handler now validates `sql` and `tabId` before storing or executing a query, posts `queryError` for invalid messages, and never invokes DuckDB for malformed input. Missing payload, null payload, and wrong-type cases were added using RED → GREEN TDD.

Updated full-suite result: 115 unit, 62 integration, and 7 E2E tests pass; compile and lint are clean.

## Residual Risks

1. **DuckDB state mismatch on engine failure:** If `engine.renameTable()` drops the old VIEW but fails creating the new one, the registry is correctly rolled back to `oldName`, but DuckDB has neither view. The table becomes unqueryable until re-registered. This is pre-existing and out of scope for #8.
