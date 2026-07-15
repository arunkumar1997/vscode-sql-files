# Sprint: Testing Foundation (T1)

**Producer:** Remy
**Goal:** Establish full testing pyramid — unit → integration → E2E — for the `file-sql` VS Code extension.
**Constraint:** Tests must run headless in CI. No paid AWS calls (mock S3).

---

## Testing Pyramid

```
        ┌─────────────┐
        │  E2E (few)  │   @vscode/test-electron + Mocha
        │  ~5 tests   │   Real VS Code, real extension host, real webview
        └─────────────┘
      ┌─────────────────┐
      │  Integration    │  Vitest, real DuckDB, fixture files
      │  ~15 tests      │  Engine + Registry + FileScanner round-trips
      └─────────────────┘
    ┌─────────────────────┐
    │  Unit               │  Vitest, mocks for vscode/duckdb/AWS SDK
    │  ~40 tests          │  Pure functions & isolated modules
    └─────────────────────┘
```

## Framework Decisions

| Layer       | Framework                         | Why                                                                      |
| ----------- | --------------------------------- | ------------------------------------------------------------------------ |
| Unit        | **Vitest**                        | Fast, TS-native, built-in mocks, works with our esbuild pipeline         |
| Integration | **Vitest**                        | Same runner; real deps loaded, `vscode` still mocked                     |
| E2E         | **@vscode/test-electron + Mocha** | Official VS Code test harness — spawns real Extension Development Host   |

Directory layout:
```
test/
├── unit/           ← Vitest, __mocks__/vscode.ts stub
├── integration/    ← Vitest, real duckdb, tmp dirs + fixtures
├── e2e/            ← Mocha, runs inside real VS Code
├── fixtures/       ← sample .csv / .json / .parquet files
└── helpers/        ← shared test utils, vscode mock factory
```

New scripts in `package.json`:
```
"test:unit":        "vitest run test/unit"
"test:integration": "vitest run test/integration"
"test:e2e":         "node ./test/e2e/runTests.js"
"test":             "npm run test:unit && npm run test:integration && npm run test:e2e"
"test:watch":       "vitest"
"coverage":         "vitest run --coverage"
```

---

## Phase 1 — Unit Tests (Agent: **Sage-Unit**)

**Modules under test (pure/isolatable):**

| Module               | Coverage targets                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `fileScanner.ts`     | `detectFileType` (csv/tsv/json/jsonl/parquet/txt/log), `deriveTableName` (sanitize, dedupe), `scanFolder` (mock fs) |
| `tableRegistry.ts`   | add / remove / rename / clear / has / get / list; EventEmitter fires exactly once per mutation               |
| `s3Handler.ts`       | `parseS3Uri` (bucket/key/isFolder), `resolveAwsCredentials` (mock fromIni), `detectBucketRegion` (mock S3)   |
| `logger.ts`          | log-level filtering, prefix formatting                                                                       |
| `types.ts`           | (types only — no runtime tests)                                                                              |

**Deliverables:**
1. Install deps: `vitest`, `@vitest/coverage-v8`, `@types/node` (already), `vitest-mock-extended`
2. `vitest.config.ts` with `test/unit/**/*.test.ts` glob, `test/helpers/vscode-mock.ts` aliased for `vscode`
3. ≥40 tests, ≥85% line coverage on the 5 modules above
4. `test/helpers/vscode-mock.ts` — minimal `vscode` API stub (EventEmitter, Uri, workspace, window)
5. `test/helpers/mockAws.ts` — jest-style mocks for `@aws-sdk/client-s3` and `@aws-sdk/credential-providers`
6. Update `package.json` scripts + `.gitignore` (coverage/, .vitest-cache/)

**Success criteria:**
- `npm run test:unit` passes locally in <5s
- Coverage report generated at `coverage/index.html`
- No test touches network or filesystem outside `os.tmpdir()`

---

## Phase 2 — Integration Tests (Agent: **Nova-Integration**)

**Depends on:** Phase 1 (Vitest config, helpers)

**Scope:** Real DuckDB, real filesystem, real fixture files. `vscode` still mocked. AWS SDK still mocked (no network).

| Scenario                            | Files touched                                             |
| ----------------------------------- | --------------------------------------------------------- |
| Register CSV → query → correct rows | `duckdbEngine.ts` + fixture `sales.csv`                   |
| Register JSON / JSONL / Parquet     | `duckdbEngine.ts` + 3 fixtures                            |
| Introspect columns of each type     | `duckdbEngine.introspectColumns`                          |
| Register folder glob (CSVs)         | `fileScanner.scanFolder` + engine                         |
| Rename table — view actually swaps  | `duckdbEngine.renameTable` + `tableRegistry.rename`       |
| Clear tables drops all views        | `clearTables.ts` command handler (mock vscode)            |
| Query result truncation at maxRows  | `executeQuery` LIMIT N+1 behavior                         |
| SQL error surfaces as `queryError`  | `openQueryEditor.ts` message handler (mock webview)       |
| addPath local file happy path       | `addPath.ts` command (mock vscode.window.showInputBox)    |
| addFolder happy path                | `addFolder.ts` command                                    |
| S3 download → temp path → register  | `s3Handler` mocked to write local tmp files, then real engine registers |
| S3 folder glob → one table entry    | Same as above with multiple parts                         |
| completionProvider suggests tables  | `providers/completionProvider.ts` with populated registry |

**Fixtures to create** (`test/fixtures/`):
- `sales.csv` (5 rows, mixed types)
- `sales.tsv`
- `events.jsonl` (5 rows)
- `nested.json` (single object array)
- `metrics.parquet` (5 rows) — generated once via a one-shot script or checked in
- `folder-a/part-1.csv`, `folder-a/part-2.csv` (same schema)

**Deliverables:**
1. `test/integration/**/*.test.ts` — ~15 tests
2. `test/fixtures/**` committed to repo
3. `test/helpers/tempDir.ts` — auto-cleanup helper
4. `vitest.integration.config.ts` — separate config (longer timeout, no parallelism if DuckDB stateful)
5. All tests pass on Linux/macOS/Windows CI matrix

**Success criteria:**
- `npm run test:integration` passes in <30s
- Zero flakes over 10 consecutive runs
- No test leaves tmp files behind

---

## Phase 3 — E2E Tests (Agent: **Ivy-E2E**)

**Depends on:** Phase 1 + 2 (fixtures, helpers)

**Scope:** Real VS Code Extension Development Host via `@vscode/test-electron`. Verifies the extension activates and end-user flows work through the actual VS Code API.

**Test scenarios (~5 essentials):**

1. **Activation** — extension activates on startup, all commands are registered
2. **Add local file → Tree view populates** — invoke `fileSql.addPath` with a fixture, verify `TablesTreeProvider` shows the new table + columns
3. **Open Query Editor webview** — invoke `fileSql.openQueryEditor`, verify a `WebviewPanel` opens and posts `ready`
4. **Run query end-to-end** — programmatically post `runQuery` to the webview, capture `queryResult` message, assert rows
5. **Clear all tables** — invoke `fileSql.clearTables`, verify tree view empties and DuckDB views are dropped

**Deliverables:**
1. `test/e2e/runTests.ts` — launches `@vscode/test-electron`
2. `test/e2e/suite/index.ts` — Mocha bootstrap
3. `test/e2e/suite/*.test.ts` — the 5 scenarios above
4. `.vscode/launch.json` — add "Extension Tests" configuration
5. `.github/workflows/test.yml` — CI matrix (Linux headless via `xvfb-run`)
6. README badge + "Running tests" section

**Success criteria:**
- `npm run test:e2e` passes locally
- CI green on Ubuntu with `xvfb-run`
- Full `npm test` (unit + integration + e2e) < 2 min

---

## Coordination Rules

- **One PR per phase** — `feature/testing-unit`, `feature/testing-integration`, `feature/testing-e2e`
- **Phase 2 does NOT start** until Phase 1 is merged (framework contract locked)
- **Phase 3 may start in parallel with Phase 2** since it uses its own harness (Mocha), but fixtures come from Phase 2
- Each phase updates `docs/sprint-testing-1/progress.md`
- No production code changes unless a test reveals a real bug — file an Issue instead

## Progress Tracker

See [progress.md](progress.md).
