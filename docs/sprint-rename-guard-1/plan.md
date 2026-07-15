# Sprint Rename-Guard-1 Plan

**Producer:** Remy
**GitHub issue:** [#8 TableRegistry.rename() silently overwrites existing table with same name](https://github.com/arunkumar1997/vscode-sql-files/issues/8)
**Method:** Strict TDD: RED → GREEN → REFACTOR at every phase
**Branch:** `feature/rename-guard`

## Priority Decision

Open-issue ranking by end-user impact (severity × reach × trust risk):

1. **#8 Rename collision** — data-loss invariant hole at the API level; UI-only guard is insufficient.
2. **#6 S3 range reads** — valuable for large datasets; high implementation complexity and narrow audience.
3. **#5 Shared configs** — broad design scope; unresolved credential handling; no current workflow blockage.

### Team Debate Summary

- **Kira (Product):** Silent data loss is a trust-killer even if UI currently prevents it. Any future API caller bypassing the input box will corrupt state.
- **Sage (Backend):** Surgical fix, three lines of guard logic. Also flagged `runQuery` handler vulnerability (export-1 QA residual) but agreed to defer to a separate issue.
- **Nova (Frontend):** Minimal frontend involvement; supports small sprint. Opposes bundling #6/#5.
- **Ivy (QA):** Perfect TDD target — existing test documents the exact bug; flip the assertion.
- **Remy decision:** Ship #8 alone. File the `runQuery` handler vulnerability as a separate issue. Do not bundle unrelated work.

## Scope

Fix `TableRegistry.rename()` to throw when `newName` already exists, and ensure the calling command handles the error. Add the no-op case for `rename('a', 'a')`.

**In scope:**
- Guard logic in `src/tableRegistry.ts` → `rename()`
- Error handling in `src/commands/clearTables.ts` → `renameTable()`
- Unit test updates in `test/unit/tableRegistry.test.ts`
- Integration test for the command-level rename collision path in `test/integration/command-clearTables.test.ts`

**Out of scope:**
- `runQuery` handler vulnerability (separate issue — recommend filing)
- Any UI/webview changes
- Issues #5, #6

## Architecture

No new components. Changes are confined to the existing `TableRegistry.rename()` contract and its single caller.

```text
TableRegistry.rename(oldName, newName)
  ├── if (oldName === newName) → return true (no-op)
  ├── if (!tables.has(oldName)) → return false (existing behavior)
  ├── if (tables.has(newName)) → throw Error("Table \"newName\" already exists")
  └── (proceed with rename)

renameTable command (clearTables.ts)
  └── catch Error from registry.rename() → showErrorMessage
```

## Phase 1 — Unit Tests: Registry Guard (Sage)

**Goal:** RED phase — write failing tests that define the correct behavior.

### TDD Checkpoint: RED

**File:** `test/unit/tableRegistry.test.ts`

1. **Modify existing test** (line ~143): Rename `"overwrites destination if newName already exists (potential bug)"` → `"throws when newName already exists"`. Change assertion from expecting silent overwrite to expecting a thrown `Error` with message containing `already exists`.
2. **Add test:** `"rename('a', 'a') is a no-op and returns true"` — register entry `a`, call `rename('a', 'a')`, assert returns `true`, entry unchanged, `onDidChange` not fired.
3. **Add test:** `"does not modify registry when newName collision throws"` — register `a` and `b`, wrap `rename('a', 'b')` in try/catch, assert both `a` and `b` still exist with original `filePath` values.

**Run command:** `npm run test:unit`
**Expected:** 3 new/modified tests FAIL (red). All other existing tests pass.

**Acceptance criteria:**
- [ ] Test `"throws when newName already exists"` fails with "expected [function] to throw"
- [ ] Test `"rename('a', 'a') is a no-op"` fails (current code deletes old and re-adds, firing event)
- [ ] Test `"does not modify registry when collision throws"` fails (current code silently overwrites)

### TDD Checkpoint: GREEN

**File:** `src/tableRegistry.ts` — `rename()` method (line ~50)

Add guards at the top of `rename()`:
```
if (oldName === newName) return true;
if (!this.tables.has(oldName)) return false;
if (this.tables.has(newName)) throw new Error(`Table "${newName}" already exists`);
```

**Run command:** `npm run test:unit`
**Expected:** All tests pass (green), including the 3 new/modified tests.

**Acceptance criteria:**
- [ ] All unit tests pass
- [ ] No existing tests broken

### TDD Checkpoint: REFACTOR

Review `rename()` for clarity. The method is small; refactoring is unlikely to be needed. Verify the early-return for `oldName === newName` does not fire `onDidChange` or call `persist()`.

**Run command:** `npm run test:unit`
**Expected:** All tests still pass.

## Phase 2 — Integration Tests: Command-Level Error Handling (Sage + Nova)

**Goal:** RED phase — verify the `renameTable` command surfaces the error to the user.

### TDD Checkpoint: RED

**File:** `test/integration/command-clearTables.test.ts`

Add tests in the `renameTable` describe block:

1. **`"shows error message when renaming to an existing table name"`** — register two tables (`a`, `b`), mock `showInputBox` to return `"b"`, call `renameTable('a', registry, engine)`, assert `showErrorMessage` was called with a message containing `already exists`, and that both `a` and `b` still exist in the registry with their original paths.
2. **`"rename to same name is a no-op"`** — register `a`, mock `showInputBox` to return `"a"`, call `renameTable('a', registry, engine)`, assert `engine.renameTable` was NOT called.

**Run command:** `npm run test:integration`
**Expected:** 2 new tests FAIL.

**Note:** The current `renameTable` command validates uniqueness in `showInputBox.validateInput`, so the `showInputBox` mock must bypass the validator (return the value directly). The purpose of this test is to verify that even if the UI validation is bypassed, the registry-level guard prevents data loss and the error is surfaced.

### TDD Checkpoint: GREEN

**File:** `src/commands/clearTables.ts` — `renameTable()` function

The existing try/catch block (lines 79-82) already catches errors from `engine.renameTable` and shows `showErrorMessage`. Since the new `Error` is thrown by `registry.rename()` which is inside the same try block, the catch should already handle it. However, verify that:
1. The catch block fires before `engine.renameTable()` is called (since the throw happens in `registry.rename()` first).
2. The rollback `registry.rename(trimmed, oldName)` in the catch is safe — if `registry.rename` threw, the registry state was never modified, so the rollback should be a no-op or also fail gracefully.

If the rollback call in the catch would now throw (because `trimmed` is `newName` which already exists), the catch block needs adjustment: wrap the rollback in its own try/catch or skip it when the original error is from the registry (not the engine).

**Run command:** `npm run test:integration`
**Expected:** All tests pass.

### TDD Checkpoint: REFACTOR

Clean up the error-handling logic in `renameTable()` if the rollback path was modified.

**Run command:** `npm run test:integration`

## Phase 3 — Regression & Full Suite (Ivy)

**Goal:** Verify no regressions across unit, integration, and E2E.

**Run commands (in order):**
```bash
npm run test:unit
npm run test:integration
npm run compile          # type-check
npm run lint             # lint
```

**E2E (if environment supports it):**
```bash
npm run pretest:e2e && npm run test:e2e
```

**Acceptance criteria:**
- [ ] All 113+ unit tests pass
- [ ] All 56+ integration tests pass
- [ ] `tsc --noEmit` reports zero errors
- [ ] ESLint reports zero errors
- [ ] E2E tests pass (7 tests)
- [ ] The existing rename E2E scenario (if any) still passes

**Edge cases to verify manually or document:**
- Rename `a` → `a` (no-op, no error)
- Rename `a` → `b` where `b` exists (error shown, both entries intact)
- Rename `a` → `b` where `b` does not exist (success, existing behavior)
- Rename nonexistent table (returns false, no crash)

## Deliverables

| # | Deliverable | Owner | Depends On |
|---|-------------|-------|------------|
| 1 | RED: Failing unit tests | Sage | — |
| 2 | GREEN: `tableRegistry.ts` guard logic | Sage | 1 |
| 3 | RED: Failing integration tests | Sage + Nova | 2 |
| 4 | GREEN: `clearTables.ts` error handling fix | Nova | 3 |
| 5 | REFACTOR: Clean up both files | Sage + Nova | 4 |
| 6 | Full regression suite + sign-off | Ivy | 5 |
| 7 | `docs/sprint-rename-guard-1/done.md` | Ivy | 6 |

## Branch & PR Strategy

- **Branch:** `feature/rename-guard` from `main`
- **Commit messages:** Use `fix:` prefix, link issue: `fix: throw on rename collision (Fixes #8)`
- **PR:** Single PR from `feature/rename-guard` → `main`
- **Merge:** Regular merge (never squash or rebase)
- **QA:** Ivy signs off before Remy merges

## Follow-Up Recommendations (Out of Scope)

1. **File GitHub Issue:** `runQuery` handler in `openQueryEditor.ts:72` has the same unguarded destructuring pattern that was fixed for `exportResults` in sprint-export-1. Should throw `queryError` on malformed payload, not crash.
2. **Pre-existing unit test failures:** 7 unit tests fail on main (fileScanner mocking, vscode module resolution) — tracked in sprint-testing-1 retro but no issue filed yet.
