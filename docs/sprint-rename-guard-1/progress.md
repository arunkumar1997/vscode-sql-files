# Sprint Rename-Guard-1 — Progress Log

The dev team updates this file after each completed task. Enables recovery if the chat overflows.

**Status:** ✅ Complete — QA signed off
**Branch:** working in current checkout (main)
**PR:** _(link when open)_

---

## Task tracker

| # | Task | Owner | Status | Notes |
|---|------|-------|--------|-------|
| 1 | RED: Failing unit tests for rename guard | Sage | ✅ | 3 tests: "throws when newName already exists", "rename('a','a') no-op", "collision preserves state" |
| 2 | GREEN: `tableRegistry.ts` guard logic | Sage | ✅ | Added early-return for same-name, throw for collision. 23/23 unit tests pass. |
| 3 | RED: Failing integration tests for command error handling | Sage + Nova | ✅ | 1 of 2 tests failed: collision test error escapes catch (rollback throws). No-op test already GREEN (command has early return). |
| 4 | GREEN: `clearTables.ts` error handling fix | Nova | ✅ | Wrapped rollback in try/catch — if registry.rename threw, no state changed so rollback is skipped. |
| 5 | REFACTOR: Clean up both files | Sage + Nova | ✅ | Minimal changes, no refactoring needed. |
| 6 | Full regression suite + QA sign-off | Ivy | ✅ | unit 115/115, integration 59/59, compile clean, lint clean, E2E 7/7 |
| 7 | Write `docs/sprint-rename-guard-1/done.md` | Ivy | ✅ | |

Status legend: ⬜ Not started · 🟡 In progress · ✅ Done · 🚧 Blocked

---

## Log

_(append newest-first — timestamp + who + what)_

- **2026-07-15, follow-up:** Fixed malformed `runQuery` payload handling with TDD. RED: missing/null payloads threw and wrong types reached DuckDB. GREEN: 3 regression cases pass; full validation is 115 unit, 62 integration, and 7 E2E tests, with compile and lint clean.
- **2026-07-15, Ivy:** QA sign-off complete. Unit: 115/115 pass. Integration: 59/59 pass (+1 new engine-failure-rollback test, GREEN immediately — no defect). Compile: 0 errors. Lint: 0 errors. E2E: 7/7 pass. All acceptance criteria met. Created done.md.
- **2026-07-15, Sage+Nova:** Phase 3 regression complete. Unit: 115/115 pass. Integration: 58/58 pass. Compile: clean. Lint: clean. E2E deferred to QA.
- **2026-07-15, final review:** Replaced the blanket rollback catch with a `registryRenamed` flag so collision errors skip rollback while engine failures still restore registry state. Integration: 59/59 pass.
- **2026-07-15, Nova:** Phase 2 GREEN. Wrapped rollback `registry.rename(trimmed, oldName)` in try/catch. If the original throw was from registry (collision), no state was modified so the rollback itself would throw — now safely caught. All 3 integration tests pass.
- **2026-07-15, Sage+Nova:** Phase 2 RED confirmed. 1 of 2 integration tests failed: `shows error message when renaming to an existing table name` — the rollback in catch block calls `registry.rename(trimmed, oldName)` which throws `Table "a" already exists` because the registry was never modified. The no-op test was already GREEN because the command has `if (newName.trim() === oldName) return` before calling registry.rename.
- **2026-07-15, Sage:** Phase 1 GREEN. Guard logic in `tableRegistry.ts` rename(): (1) `oldName === newName` → returns `this.tables.has(oldName)` (no-op, no event); (2) collision → `throw new Error("Table \"x\" already exists")`; (3) throw happens before any mutation so state is preserved on collision. All 115 unit tests pass.
- **2026-07-15, Sage:** Phase 1 RED confirmed. 3 tests fail: "throws when newName already exists" → `expected [Function] to throw`; "rename('a','a') no-op" → changeSpy called 1 time (should be 0); "collision preserves state" → `registry.has("a")` is false (old entry was deleted by current code).
- **2026-07-15, Remy:** Sprint plan written. Awaiting dev team pickup.

---

## Blockers

_(list anything preventing progress — Remy resolves)_

- None yet.

---

## Decisions made during the sprint

_(record any judgement calls the dev team makes that aren't in the plan)_

- The "rename to same name is a no-op" integration test is GREEN without any command change — the existing `renameTable()` command already returns early when `newName.trim() === oldName` (line 67). No production change forced for this; the registry-level guard is the safety net for any future API callers.
- The command records whether `registry.rename()` completed. Collision errors leave the flag false and skip rollback; engine errors leave it true and restore the original registry name without swallowing rollback failures.
- `rename('a', 'a')` returns `this.tables.has(oldName)` rather than a hardcoded `true` — returns `false` if the entry doesn't exist, matching the existing "source not found" behavior.
