# Sprint config-1 — Progress

## Checkpoint 8: Pipeline AbortSignal for S3 Download Streaming

**Status:** ✅ Complete
**Date:** 2026-07-15
**Agent:** Sage (Backend)

### Changes Made

| # | Change | File | Details |
|---|--------|------|---------|
| 1 | Pass AbortSignal to stream/promises pipeline | s3Handler.ts | `downloadS3File` now passes `{ signal: abortSignal }` as options arg to `pipeline()`, so active body-to-file streaming aborts when the signal fires |

### Tests Added / Updated

| File | Test | Type |
|------|------|------|
| test/unit/s3Handler.test.ts | "passes AbortSignal to pipeline when provided" | Assert pipeline receives `{ signal }` options arg |
| test/unit/s3Handler.test.ts | "does not pass signal options to pipeline when no AbortSignal given" | Assert pipeline called with exactly 2 args (no options) |
| test/unit/s3Handler.test.ts | "rejects immediately when signal is already aborted" | Pre-flight abort check |
| test/unit/s3Handler.test.ts | "abort during streaming rejects the pipeline" | Simulates abort during send; pipeline mock sees aborted signal, rejects |

### Validation Results

- **Focused tests (s3Handler):** 47/47 pass
- **Focused tests (blockers + configCommands):** 43/43 pass
- **Unit tests:** 321/321 pass (13 files)
- **Integration tests:** 75/75 pass (17 files)
- **TypeScript compile:** clean
- **ESLint:** 0 errors on modified files
- **Build:** clean

---

## Checkpoint 7: Slices 3–4 Final Four Blockers

**Status:** ✅ Complete
**Date:** 2026-07-15
**Agent:** Sage (Backend)

### Changes Made

| # | Change | File | Details |
|---|--------|------|---------|
| 1 | Post-register cancellation/stale rollback | configCommands.ts | After every `registerTable` await in `loadLocalTable`, `loadS3Folder`, `loadS3SingleFile`: check cancellation and runtime identity; rollback view, clean temp, return configured/false |
| 2 | StaleEntryError for explicit failure | configCommands.ts | New error class; all stale `return;` paths converted to `throw StaleEntryError` so parent never treats stale as success, always cleans temp |
| 3 | Recursive glob for non-Hive S3 folders | configCommands.ts | Changed from `*ext` to `**/*ext` so nested files in S3 prefixes are captured by DuckDB glob |
| 4 | AbortController before region lookup | configCommands.ts | Created before `detectBucketRegion` (was after); signal propagated through region/list/download pipeline |
| 5 | detectBucketRegion accepts AbortSignal | s3Handler.ts | New `abortSignal?` parameter forwarded to S3Client.send |
| 6 | _tempDir only attached on success | configCommands.ts | Restructured loadS3Table so `_tempDir` is set only after loadS3Folder/loadS3SingleFile succeeds; catch block cleans temp on any error |

### New Tests Added

| File | Tests | Coverage |
|------|-------|----------|
| test/unit/slices-3-4-blockers.test.ts | 15 | Post-register cancel rollback (local, S3 single, S3 folder); stale identity rollback; recursive glob; stale cleanup/false; _tempDir not attached on stale; AbortSignal propagation to region/list/download |

### Validation Results

- **Focused tests:** 15/15 pass
- **Unit tests:** 317/317 pass (13 files)
- **Integration tests:** 75/75 pass (17 files)
- **TypeScript compile:** clean
- **ESLint:** 0 errors on modified files
- **Build:** clean

---

## Checkpoint 6: Slices 3–4 Ownership-Correct Remediation

**Status:** ✅ Complete
**Date:** 2026-07-15
**Agent:** Sage (Backend) + Nova (E2E fixes)

### Changes Made

| # | Change | Owner | Details |
|---|--------|-------|---------|
| 1 | Per-instance idempotent init on DuckDBEngine | DuckDBEngine | `ensureInitialized()` with promise lock; retryable on failure; no module-level state |
| 2 | Removed unconditional activation init | extension.ts | `activate()` no longer blocks on `engine.init()`; all paths use lazy `ensureInitialized()` |
| 3 | ensureInitialized at all entry points | addPath, addFolder, configCommands, extension restoreEntries, openFileInSql | All registration paths call `engine.ensureInitialized()` before DuckDB operations |
| 4 | registerTable failure-atomic (internal) | DuckDBEngine | Rollback view if introspection fails — no caller-side try/drop needed |
| 5 | TableRegistry.add rejects loading entries | TableRegistry | Throws if adding over an entry with loadState="loading" |
| 6 | removeTable command checks loading guard | clearTables.ts | Blocks remove/clear during loading with user warning |
| 7 | configureS3 uses escapeSqlString | DuckDBEngine | region, keyId, secret, token all escaped via central `escapeSqlString` |
| 8 | S3 temp dirs use random IDs only | s3Handler | `createPerLoadTempDir()` takes no arguments; uses `load-` prefix + mkdtemp |
| 9 | S3 path containment validation | s3Handler, configCommands | `assertContainedPath()` validates every joined relative key stays inside temp dir |
| 10 | S3 cleanup in finally blocks | s3Handler | `downloadS3Folder`, `downloadS3HiveFolder`, `downloadS3Entries` all cleanup temp on error |
| 11 | Cancellation AbortSignal for S3 SDK | s3Handler, configCommands | `listS3Keys`/`downloadS3File` accept `AbortSignal`; `loadS3Table` creates AbortController linked to CancellationToken |
| 12 | ensureEngineInitialized delegates to engine | configCommands | Module-level promise lock removed; wrapper just calls `engine.ensureInitialized()` |

### New Tests Added

| File | Tests | Type |
|------|-------|------|
| test/unit/race-containment-rollback.test.ts | 11 | Unit: registry loading guards, path containment, random temp dirs |
| test/integration/engine-atomicity.test.ts | 7 | Integration: failure-atomic rollback, ensureInitialized idempotency, SQL injection through configureS3/registerTable paths |

### Validation Results

- **Unit tests:** 302/302 pass (12 files)
- **Integration tests:** 75/75 pass (17 files)
- **E2E tests:** 7/7 pass (5 files)
- **TypeScript compile:** clean
- **ESLint:** 0 errors on changed files
- **Build:** clean

---

## Checkpoint 5: Slices 3–4 Architecture Blocker Remediation

**Status:** ✅ Complete
**Date:** 2026-07-15
**Agent:** Sage (Backend)

### Architecture Blockers Resolved

| # | Blocker | Fix |
|---|---------|-----|
| 1 | S3 temp shared across tables — cross-table deletion risk | Per-load temp dirs; cleaned on fail/cancel/unload; session root only on deactivate |
| 2 | Unload transitions on real drop failure | Preserves loaded state on real dropTable failure; user can retry |
| 3 | Registration not failure-atomic | Wrap registerTable; drop view on failure |
| 4 | No runtime-ID recheck after async mutations | isEntryStale() helper; rechecked after init, downloads, register |
| 5 | clear() while tables loading | Throws if any table is loading |
| 6 | Engine init not idempotent | Shared promise lock; one init; all await same promise |
| 7 | S3 folder ignores fileType/hivePartitioning | Filters keys by configured fileType; validates hive layout |
| 8 | Cancellation treated as error | CancellationError class; reverts to configured |
| 9 | No central SQL escaping | escapeSqlString/escapeDuckDBIdentifier; used everywhere |
| 10 | Save silently drops entries | Aborts entirely; names unrepresentable entries |
| 11 | Ad-hoc reload safety | Preserved — re-registers from verified absolute filePath |

### Validation Results

- **Full unit suite:** 292/292 pass (11 test files)
- **Full integration suite:** 68/68 pass (16 test files)
- **TypeScript compile:** clean
- **ESLint:** 0 errors on sprint files
- **Build:** clean

---

## Checkpoint 4: Slices 3–4 — Load/Unload/Reload + Save Commands

**Status:** ✅ Complete  
**Date:** 2026-07-15  
**Agent:** Sage (Backend) + Nova (Frontend registration)

### Delivered

| Command | ID | Behavior |
|---------|----|----------|
| Load Table | `fileSql.loadTable` | Transitions configured/error → loading → loaded\|error; resolves local paths relative to workspace; S3 uses ambient credentials + temp download; lazy engine init; runtime-ID stale guard; blocks duplicate loads |
| Load All Tables | `fileSql.loadAllTables` | Iterates configured/error entries; continues after failures; cancellable via progress API; reports loaded/failed count |
| Unload Table | `fileSql.unloadTable` | Drops DuckDB view; clears columns; resets S3 filePath to source; returns to configured; blocks during loading |
| Reload Table | `fileSql.reloadTable` | Unloads then loads; cancellable; blocks during loading |
| Save Workspace Config | `fileSql.saveWorkspaceConfig` | Gathers all entries; converts via toConfigEntry; atomic write via ConfigManager; confirmation message; never implicit |

### Key Implementation Decisions

1. **Lazy engine init** — `ensureEngine()` calls `engine.init()` on first load if `!engine.isReady()`. If init fails, entry transitions to error with clear message.
2. **Runtime-ID stale guard** — Before and after async engine init, verifies the entry still exists and has the same runtime ID (prevents stale transitions if entry was removed during async work).
3. **Cancellation** — `loadTable` and `loadAllTables` accept `CancellationToken`; on cancel, reverts to configured state.
4. **loadAll continues after failure** — Each table is loaded independently; failures set error state but don't stop the batch.
5. **S3 canonical source** — Uses `entry.source` (the declared s3:// URI) for all S3 operations; temp path is runtime-only.
6. **Unload resets S3 filePath** — On unload, S3 entries get filePath reset to source (temp files remain until extension deactivation cleanup).
7. **Save is the only writer** — `saveWorkspaceConfig` is the sole path to `.filesql/config.json`; never triggered implicitly.
8. **toConfigEntry filters** — Entries outside workspace or S3 without valid source are silently skipped with a warning if all entries were filtered.

### Files Created

| File | Purpose |
|------|---------|
| `src/commands/configCommands.ts` | Load, LoadAll, Unload, Reload, SaveWorkspaceConfig implementations |
| `test/unit/configCommands.test.ts` | 28 unit tests for all commands |
| `test/integration/config-load-unload.test.ts` | 6 integration tests with real DuckDB |

### Files Modified

| File | Change |
|------|--------|
| `src/extension.ts` | Import + register 5 new commands (loadTable, loadAllTables, unloadTable, reloadTable, saveWorkspaceConfig) |
| `package.json` | Add 5 command contributions with icons |

### Validation Results

- **Focused unit tests (configCommands):** 28/28 pass
- **Full unit suite:** 267/267 pass (9 test files)
- **Focused integration test:** 6/6 pass
- **Full integration suite:** 68/68 pass (16 test files)
- **TypeScript compile:** `tsc --noEmit` clean (0 errors)
- **ESLint:** 0 errors, 0 warnings on modified source files
- **Build:** `npm run build` clean

### Not Implemented (deferred per plan)

- Tree view state rendering — Slice 5
- Completion filtering by load state — Slice 6
- Config activation / file watcher — Slice 7
- Saved queries — out of scope

---

## Checkpoint 3: Normalize-before-validate fix (Slices 1–2 final repair)

**Status:** ✅ Complete  
**Date:** 2026-07-15  
**Agent:** Sage (Backend)

### Problem

Leading/trailing whitespace in `name` or `source` fields could bypass safety checks:
- `" /etc/passwd"` passed `isValidSource` (doesn't start with `/`) then became `/etc/passwd` after trim
- `" ../../../etc/passwd"` bypassed traversal segment check then became a traversal after trim
- `"  s3://user:pass@bucket/key"` bypassed S3 credential detection then became a credential URI
- `" sales "` and `"sales"` appeared as distinct names, creating post-normalization duplicates

### Fix

Normalize (trim) `name` and `source` BEFORE all validation, path/S3 safety checks, and duplicate detection in:
1. `validateTableEntry()` — reads on parseAndValidateConfig path
2. `validateForWrite()` — writes on writeConfig path
3. `TableRegistry.addConfigured()` — runtime registration path

### Also Fixed

- `test/helpers/vscode-mock.ts`: replaced `require("path")` with top-level `import path from "path"` to fix `no-require-imports` lint error exposed by this sprint's eslint config tightening.

### Regression Tests Added (8 new)

| Test | Purpose |
|------|---------|
| rejects leading-whitespace absolute path | `" /etc/passwd"` → caught as absolute |
| rejects trailing-whitespace traversal | `" ../../../etc/passwd"` → caught as traversal |
| rejects whitespace-padded s3 credential URI | `"  s3://user:pass@bucket/key"` → caught |
| rejects whitespace-padded s3 query string URI | `" s3://bucket/key?token=SECRET"` → caught |
| detects duplicate names after trimming | `"sales"` + `" sales "` → duplicate detected |
| writeConfig rejects whitespace-padded absolute path | write-side validation catches |
| writeConfig detects duplicates after trimming | write-side dedup catches |
| writeConfig rejects whitespace-padded traversal source | write-side traversal catches |

### Round-trip Test Added (2 new)

| Test | Purpose |
|------|---------|
| emitted JSON is accepted by readConfig and entries are equivalent | genuine workspace.fs-backed writeConfig→readConfig proving JSON is accepted |
| round-trip preserves trimmed values and does not duplicate | whitespace-padded input normalizes on write, reads back clean |

### Validation Results

- **Focused tests (3 files):** 124/124 pass
- **Full unit suite:** 239/239 pass (8 test files)
- **Full integration suite:** 62/62 pass (15 test files)
- **TypeScript compile:** `tsc --noEmit` clean (0 errors)
- **ESLint:** 0 errors, 0 warnings on sprint-modified source + test files
- **Build:** `npm run build` clean

### Files Modified

| File | Change |
|------|--------|
| `src/configManager.ts` | Normalize name/source before validation in `validateTableEntry` and `validateForWrite` |
| `src/tableRegistry.ts` | Normalize name/source in `addConfigured` before has-check and entry creation |
| `test/helpers/vscode-mock.ts` | `require("path")` → `import path from "path"` |
| `test/unit/configManager.test.ts` | +8 regression tests for whitespace bypass |
| `test/unit/configManager-io.test.ts` | +2 round-trip tests (writeConfig→readConfig equivalence) |
| `docs/sprint-config-1/progress.md` | This checkpoint |

---

## Checkpoint 2: Context Architect Blocker Resolution (Slices 1–2)

**Status:** ✅ Complete  
**Date:** 2026-07-15  
**Agent:** Sage (Backend)

### Blockers Resolved

| # | Blocker | Fix | Verified |
|---|---------|-----|----------|
| 1 | Previously leaked `origin=config` / `loadState=configured` entries restored from workspaceState | `loadFromStorage()` now filters out entries with `origin==="config"` or `loadState==="configured"` before restoring. Also clears transient `loading`/`error` states on restore. | ✅ 3 new tests |
| 2 | Fabricated basename/fallback from mutable runtime fields in `toConfigEntry` | Removed basename fallback. `toConfigEntry` returns `null` for local sources outside workspace. Source established declaratively at entry creation only. | ✅ Tests confirm null return |
| 3 | Save/export for local sources outside workspace and S3 entries missing canonical source | `toConfigEntry` returns `null` (rejects) for outside-workspace local paths and S3 entries with malformed/missing source | ✅ 3 new rejection tests |
| 4 | Source ownership mutable via `entry.source = "..."` | `addConfigured` uses `Object.defineProperty` to make `source` non-writable and non-configurable on config-origin entries | ✅ Test confirms throw on mutation |
| 5 | Weak S3 URI parsing (only checked `v.length > 5`) | New `parseS3Uri()` strictly validates bucket/key, rejects whitespace-only bucket, userinfo/credential forms, query strings, fragments. Preserves trailing-slash semantics. | ✅ 11 parseS3Uri tests + 6 isValidSource tests + 5 config validation tests |
| 6 | No stable runtime identity; rename/remove allowed during loading | Added `runtimeIds` map with `crypto.randomUUID()` per entry. `getRuntimeId()` API. `rename()` and `remove()` throw during `loadState==="loading"`. ID preserved through rename. | ✅ 5 identity tests + 5 guard tests |
| 7 | Temp names used `Date.now()` (predictable, collision-prone) | Replaced with `crypto.randomBytes(8).toString("hex")` for 16-char random hex suffix. Single try/catch with `writeSucceeded` flag; cleanup in catch. | ✅ Regex test confirms pattern |
| 8 | `isFileNotFoundError` had broad message-based fallback regex | Removed `/not found|ENOENT|FileNotFound/i` message fallback. Now only recognizes `code==="FileNotFound"`, `code==="ENOENT"`, `name==="EntryNotFound (FileSystemError)"` | ✅ Test confirms generic "not found" message → ConfigReadError |
| 9 | Broad `no-explicit-any: "off"` for all tests | Changed to `"warn"` for `test/**`, with `"off"` scoped only to `test/helpers/vscode-mock.ts`. New tests use typed `MockWorkspaceFs` helper + `as unknown as` casts. | ✅ 0 lint errors on sprint files |

### Validation Results

- **Focused tests (3 files):** 114/114 pass
- **Full unit suite:** 229/229 pass (8 test files)
- **TypeScript compile:** `tsc --noEmit` clean (0 errors)
- **ESLint:** 0 errors, 0 warnings on sprint-modified source + test files
- **Pre-existing:** 1 `no-require-imports` error in `test/helpers/vscode-mock.ts` (unrelated, pre-sprint)

### Files Modified/Created

| File | Action |
|------|--------|
| `src/configManager.ts` | Strict S3 parsing, narrowed ENOENT detection, reject outside-workspace, crypto-random temps |
| `src/tableRegistry.ts` | Runtime IDs, loading guards, leaked-entry filter, source immutability |
| `eslint.config.mjs` | Reverted broad test `any` relaxation → warn + scoped helper file exception |
| `test/helpers/vscode-mock.ts` | Added `MockWorkspaceFs` + `mockWorkspaceFs()` typed helper |
| `test/unit/tableRegistry-states.test.ts` | +23 tests (leak filtering, runtime IDs, loading guards, immutability) |
| `test/unit/configManager.test.ts` | +22 tests (S3 parsing, isValidSource, toConfigEntry rejections) |
| `test/unit/configManager-io.test.ts` | Rewritten with typed helpers; +2 tests (narrowed ENOENT, random temp) |
| `test/unit/tableRegistry.test.ts` | Fixed `as any` → typed memento cast |

---

## Checkpoint 1: Slice 1 + Slice 2 (Types & ConfigManager foundation)

**Status:** ✅ Complete  
**Date:** 2026-07-15  
**Agent:** Sage (Backend)

### Delivered

| Item | File | Status |
|------|------|--------|
| `TableLoadState` type | `src/types.ts` | ✅ |
| `ConfigTableEntry` interface | `src/types.ts` | ✅ |
| `loadState` + `loadError` fields on `TableEntry` | `src/types.ts` | ✅ |
| `TableOrigin` type + `origin` + `source` fields on `TableEntry` | `src/types.ts` | ✅ |
| `TableRegistry.addConfigured()` | `src/tableRegistry.ts` | ✅ |
| `TableRegistry.setLoadState()` | `src/tableRegistry.ts` | ✅ |
| `TableRegistry.getLoaded()` | `src/tableRegistry.ts` | ✅ |
| `ConfigManager` service (read/write/validate/toConfigEntry) | `src/configManager.ts` | ✅ |
| Unit tests — state machine (21 tests) | `test/unit/tableRegistry-states.test.ts` | ✅ |
| Unit tests — config validation (30 tests) | `test/unit/configManager.test.ts` | ✅ |
| Unit tests — workspace.fs I/O failures (16 tests) | `test/unit/configManager-io.test.ts` | ✅ |

### Validation Results

- **Focused tests:** 73/73 pass (222ms)
- **Full unit suite:** 188/188 pass (355ms), 8 test files
- **TypeScript compile:** `tsc --noEmit` clean (0 errors)
- **ESLint:** 0 errors, 0 warnings on modified files
- **Backward compat:** Existing tests unmodified and green

---

## Checkpoint 1 Remediation (Context Architect corrections)

**Status:** ✅ Complete  
**Date:** 2026-07-15  
**Agent:** Sage (Backend)

### Corrections Applied

| # | Requirement | Implementation | Verified |
|---|-------------|----------------|----------|
| 1 | Explicit runtime origin `config\|adhoc`, legacy default adhoc, persist only adhoc | Added `TableOrigin` type, `origin` field on `TableEntry`. `persist()` filters to adhoc-only. `addConfigured()` does NOT call persist. `loadFromStorage()` marks restored entries as adhoc. | ✅ Tests confirm config entries never leak to memento |
| 2 | Preserve declarative `source` separately from runtime `filePath` | Added `source?: string` to `TableEntry`. `addConfigured` stores source. `toConfigEntry` uses `source` preferentially. S3 entries without valid source return `null`. | ✅ Tests cover source preservation and null rejection |
| 3 | Fail entire config for any invalid row, duplicate, unknown/credential/runtime property | `parseAndValidateConfig` now returns zero entries if ANY row has errors. Checks `APPROVED_TABLE_FIELDS` allowlist. Rejects `FORBIDDEN_FIELDS` (credentials/runtime). Rejects unknown top-level keys. `writeConfig` validates output before writing. | ✅ Tests for unknown props, credentials, runtime state, top-level keys, write validation |
| 4 | Cross-platform absolute/UNC/device path rejection, slash normalization, traversal rejection | `isValidSource` rejects: backslashes, `/` prefix, `//` UNC, `C:` device paths, `..` traversal segments. Slash normalization in `toConfigEntry`. | ✅ Tests for UNC, device paths, traversal, backslashes |
| 5 | Truly safe same-directory temp+rename, no silent non-atomic fallback, propagate errors, best-effort cleanup | Removed silent fallback to direct write. Directory errors propagate. Temp write failure propagates. Rename failure propagates after best-effort temp cleanup. | ✅ Tests for all three failure paths + cleanup behavior |
| 6 | Stable runtime identity / mutation guard foundation | `computeConfigDigest()` (djb2 hash of normalized entries). `lastConfigDigest` getter. `isConfigUnchanged()` method for reload detection. No IDs persisted in v1 config. | ✅ Tests for digest stability and change detection |
| 7 | Distinguish missing file from other read failures, actionable diagnostics | `readConfig` returns `{ entries, diagnostics, missing }`. Throws `ConfigReadError` (with `code: "NOT_FOUND" | "READ_FAILURE"`, uri, cause) for non-ENOENT errors. `isFileNotFoundError` handles vscode.FileSystemError patterns. | ✅ Tests for FileNotFound vs EACCES vs generic I/O |

### Additional Items

- **S3 trailing-slash semantics preserved** — validator does not strip or enforce trailing slashes
- **No configurable config path** — hardcoded `.filesql/config.json`
- **No inline `$schema`** — rejected as unknown top-level property
- **ESLint test override added** — `eslint.config.mjs` relaxes `no-explicit-any` and `no-unused-vars` (with `_` prefix) for test files

### Design Decisions

1. **`loadState` is optional on `TableEntry`** — `undefined` means "loaded" for backward compat with all existing ad-hoc adds.
2. **`origin` defaults to `"adhoc"`** — existing entries from memento are always adhoc; no migration needed.
3. **`source` field on `TableEntry`** — preserves the original declarative path/URI from config, independent of runtime filePath resolution.
4. **Strict config validation** — entire config fails on any row error (no partial loading). This is safer for team-shared configs.
5. **`toConfigEntry` returns `null`** for S3 entries that lack a valid source (temp download path cannot be persisted).
6. **Config digest uses djb2** — fast deterministic hash, sufficient for mutation detection. Not crypto.
7. **`ConfigReadError`** — typed error subclass with `code`, `uri`, `cause` for actionable downstream handling.

### Not Implemented (later slices)

- Commands (load/unload/reload/save) — Slice 3, 4
- Tree view state rendering — Slice 5
- Completion gating — Slice 6
- Activation rewiring — Slice 7
- File watcher on config — deferred to Slice 7
