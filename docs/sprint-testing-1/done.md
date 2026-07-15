# Sprint Testing-1 — Done (Retro)

**Sprint duration:** 3 phases over 1 sprint
**Agents:** Sage-Unit, Nova-Integration, Ivy-E2E
**Branch:** `feature/testing-e2e` (Phase 3)

---

## Summary

| Layer       | Framework                     | Tests | Wall-clock |
| ----------- | ----------------------------- | ----- | ---------- |
| Unit        | Vitest                        | 28*   | ~300ms     |
| Integration | Vitest (real DuckDB)          | 17    | ~740ms     |
| E2E         | @vscode/test-electron + Mocha | 7     | ~3s        |
| **Total**   |                               | **52**| ~4s        |

*\*Unit tests have 7 pre-existing failures (fileScanner mocking, vscode module resolution) — tracked separately.*

---

## Framework Choices

| Decision                          | Rationale                                                   |
| --------------------------------- | ----------------------------------------------------------- |
| Mocha (not Vitest) for E2E        | VS Code's test harness requires Mocha inside the Extension Host process |
| TDD UI (`suite`/`test`)           | Cleaner grouping for VS Code extension scenarios            |
| `@vscode/test-electron`           | Official harness — downloads real VS Code, spawns headless  |
| No sinon — direct monkey-patching | Simpler; only `showWarningMessage` needed patching           |
| `__testApi` export gated by mode  | Minimal production change; only exposed in ExtensionMode.Test |

## Gotchas Encountered

1. **`rootDir` conflict** — e2e tsconfig's `rootDir` must be project root (`../..`) to cover both `src/` type imports and `test/e2e/` sources. This means compiled output lands at `out-e2e/test/e2e/`.
2. **Mocha UI mismatch** — `suite`/`test` requires `ui: "tdd"`, not `bdd`. Error manifests as `ReferenceError: suite is not defined` at load time.
3. **`openQueryEditor` requires tables** — the command early-returns with an info message if no tables are loaded. Tests must pre-load a table before invoking it.
4. **Pre-existing unit test failures** — 7 unit tests fail on main (fileScanner mock issue, vscode module resolution). Not caused by E2E work.

## Production Code Changes

Only one change: `src/extension.ts`
- Added `TestApi` interface and conditional return from `activate()` when `context.extensionMode === vscode.ExtensionMode.Test`
- Zero impact on production users — the export is only returned in test mode

## CI

`.github/workflows/test.yml` — runs unit, integration, and E2E (via `xvfb-run`) on Ubuntu with Node 20.

## What's Next

- Fix pre-existing unit test failures (fileScanner mocking, vscode module resolution)
- Add webview interaction tests (posting messages to the query editor)
- Expand E2E coverage once webview communication is testable
