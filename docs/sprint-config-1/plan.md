# Sprint config-1 — Lazy-load workspace configuration (Issue #5)

**Branch:** `arunkumar1997/issue5` (based on `main` @ `2a3d27e`)  
**Goal:** Implement `.filesql/config.json` as a team-shareable, lazy-load workspace config.  
**Constraint:** No auto-loading, no credential persistence, no eager DuckDB/S3 work.

---

## Approved Architecture Summary

| Rule | Detail |
|------|--------|
| Config is metadata only | `.filesql/config.json` declares table sources; never stores credentials, runtime state, or temp paths |
| Tables start unloaded | On workspace open, configured tables appear as "Not loaded" rows in the tree |
| Explicit load only | No DuckDB init, no file reads, no S3 requests until user clicks **Load** or **Load All** |
| Explicit save only | Config file is created/overwritten only via **Save Workspace Configuration** command |
| State machine | Each table has a state: `configured` → `loading` → `loaded` / `error`; plus `unload` back to `configured` |
| Completions gated | Only `loaded` tables appear in SQL completions and query metadata |
| Safe to commit | No secrets, no absolute temp paths, no machine-specific data in config |

---

## Config File Schema (target)

```jsonc
// .filesql/config.json
{
  "version": 1,
  "tables": [
    {
      "name": "sales",
      "source": "./data/sales.csv",     // relative local path
      "fileType": "csv"
    },
    {
      "name": "events",
      "source": "s3://bucket/path/events/",  // S3 URI
      "fileType": "parquet",
      "hivePartitioning": true
    }
  ]
}
```

Fields: `name` (required), `source` (required — relative path or s3:// URI), `fileType` (required), `hivePartitioning` (optional bool). Nothing else persisted.

---

## Ordered Implementation Slices

### Slice 1 — Types & State Machine (Sage)

**Deliverable:** Extend `types.ts` and `TableRegistry` for load states.

1. Add `TableLoadState` enum: `configured | loading | loaded | error`
2. Add `loadState` field to `TableEntry` (default: `loaded` for backward compat with ad-hoc adds)
3. Add `ConfigTableEntry` interface (subset: `name`, `source`, `fileType`, `hivePartitioning`) — what lives in the config file
4. `TableRegistry`: add `addConfigured(entries: ConfigTableEntry[])` — adds with state `configured`, no DuckDB call
5. `TableRegistry`: add `setLoadState(name, state)` with event emission
6. Ensure `getLoaded(): TableEntry[]` helper returns only `state === 'loaded'` entries

**Gate:** Unit tests pass for state transitions. No DuckDB touched.

---

### Slice 2 — ConfigManager Service (Sage)

**Deliverable:** New `src/configManager.ts` — reads/writes `.filesql/config.json`.

1. `readConfig(workspaceRoot: Uri): ConfigTableEntry[]` — reads + validates JSON; returns empty array if file missing or malformed (log warning, never throw)
2. `writeConfig(workspaceRoot: Uri, entries: ConfigTableEntry[]): void` — writes pretty-printed JSON with `version: 1`
3. `toConfigEntry(entry: TableEntry): ConfigTableEntry` — strips runtime fields (columns, filePath if S3, loadState)
4. Source paths: local paths stored **relative** to workspace root; S3 URIs stored verbatim
5. File watcher: optional `vscode.workspace.createFileSystemWatcher` on `.filesql/config.json` — fires event on external change

**Gate:** Integration test: write config → read config → entries match. Invalid JSON → empty array + logged warning.

---

### Slice 3 — Load / Unload / Reload Commands (Sage + Nova)

**Deliverable:** Commands that perform the actual DuckDB registration on demand.

1. `fileSql.loadTable` — takes a table name; transitions `configured` → `loading` → `loaded` (or `error`); calls existing `DuckDBEngine.registerTable`; for S3, triggers download then register
2. `fileSql.loadAllTables` — iterates all `configured`/`error` entries, loads each
3. `fileSql.unloadTable` — drops the DuckDB view, transitions to `configured`, clears `columns`
4. `fileSql.reloadTable` — unload then load (for refreshing data)
5. Guard: `DuckDBEngine.init()` is called lazily on first load (not on extension activation if only config tables exist)

**Gate:** Can load a local CSV from config, query it, unload it, confirm it disappears from completions.

---

### Slice 4 — Save Workspace Configuration Command (Sage)

**Deliverable:** `fileSql.saveWorkspaceConfig` command.

1. Gathers all current `TableEntry` items (both ad-hoc and configured)
2. Converts to `ConfigTableEntry[]` via `toConfigEntry()`
3. Calls `ConfigManager.writeConfig()`
4. Shows info message: "Workspace configuration saved to .filesql/config.json"
5. Never auto-saves. Never triggers on table add/remove.

**Gate:** Add tables ad-hoc → run command → `.filesql/config.json` written correctly. Re-open workspace → tables appear as "Not loaded".

---

### Slice 5 — Tree View States (Nova + Milo)

**Deliverable:** `TablesTreeProvider` shows load state visually.

1. Tree nodes for `configured` tables: label + "(Not loaded)" description, dimmed icon
2. Tree nodes for `loading` tables: spinner/progress icon
3. Tree nodes for `loaded` tables: current behavior (expand to columns)
4. Tree nodes for `error` tables: error icon + tooltip with message
5. Context menus:
   - `configured` / `error`: "Load", "Remove"
   - `loaded`: "Unload", "Reload", "Rename", "Remove", "Copy Name"
6. Toolbar: "Load All" button (visible when any table is `configured`)

**Gate:** Visual inspection — all four states render correctly; context menus are state-appropriate.

---

### Slice 6 — Completions & Query Metadata Gating (Nova)

**Deliverable:** Only loaded tables participate in IntelliSense.

1. `SqlCompletionProvider`: filter to `registry.getLoaded()` instead of `registry.getAll()`
2. `openQueryEditor` webview `tablesChanged` message: send only loaded tables
3. Ensure unloading a table immediately removes it from active webview completions

**Gate:** Add a config table (not loaded) → no completions for it. Load it → completions appear. Unload → gone.

---

### Slice 7 — Activation Flow Rewire (Sage)

**Deliverable:** `extension.ts` activation handles config-based startup.

1. On activate: check for `.filesql/config.json` in workspace root
2. If found: call `ConfigManager.readConfig()`, then `registry.addConfigured(entries)`
3. Do NOT call `DuckDBEngine.init()` unless there are already loaded entries (from memento) or user triggers a load
4. Existing memento-persisted tables still restore as `loaded` (backward compat)
5. If both memento AND config have the same table name: memento (loaded) wins — config entry is skipped with a log

**Gate:** Fresh workspace with only config file → sidebar shows "Not loaded" entries, no DuckDB process spawned. Add ad-hoc table → DuckDB inits on demand.

---

### Slice 8 — Test Suite (Ivy)

**Deliverable:** Comprehensive tests for the feature.

1. **Unit tests** (`test/unit/`):
   - `configManager.test.ts` — read/write/validate/malformed
   - `tableRegistry-states.test.ts` — state transitions, `getLoaded()` filter
2. **Integration tests** (`test/integration/`):
   - `config-load-unload.test.ts` — load from config, query, unload, verify completions gated
   - `config-save.test.ts` — save command writes correct JSON
   - `config-activation.test.ts` — activation with config only (no DuckDB init)
3. **Regression**: existing tests must still pass (no breaking changes to ad-hoc flow)

**Gate:** `npm test` green. Coverage on new code ≥ 80%.

---

## Agent Assignments

| Agent | Role | Slices | Notes |
|-------|------|--------|-------|
| **Sage** (Backend) | Lead implementer | 1, 2, 3, 4, 7 | Owns all service-layer code, state machine, commands |
| **Nova** (Frontend) | UI implementer | 3 (collab), 5, 6 | Owns tree view states, completion gating, context menus |
| **Milo** (Art/UX) | Design advisor | 5 (collab) | Defines icons, color tokens, state descriptions |
| **Ivy** (QA) | Test author | 8 | Writes all tests after slices 1–7 land; also reviews each slice's inline tests |
| **Context Architect** | Observer/Reviewer | — | Reviews at architecture checkpoints (after slices 2, 4, 7); does NOT write code |

---

## Architecture Review Checkpoints

1. **After Slice 2** — Context Architect reviews: config schema finalized, no credential leaks, relative path handling correct
2. **After Slice 4** — Context Architect reviews: save semantics correct, nothing auto-persists, backward compat with memento entries
3. **After Slice 7** — Context Architect reviews: full activation flow, lazy DuckDB init, no regressions in ad-hoc flow

---

## Constraints & Safety

- **Branch**: All work on `arunkumar1997/issue5` — do not touch `main`
- **No force push**: preserve existing commit history
- **Backward compat**: ad-hoc table registration (addPath, addFolder) must continue to work identically; those tables get `loadState: 'loaded'` immediately
- **No breaking changes**: existing tests must pass without modification
- **Config file is opt-in**: extension works fine without `.filesql/config.json`
- **No credentials persisted**: S3 tables in config store only the URI; credentials come from AWS profile at load time

---

## Dev Team Handoff Prompt

```
You are the dev team (Sage, Nova, Milo) implementing sprint-config-1 for file-sql.
Branch: arunkumar1997/issue5 (already checked out, based on main @ 2a3d27e).

Read docs/sprint-config-1/plan.md for the full specification.

Implementation order: Slice 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8.
Each slice must pass its gate before moving to the next.

Key rules:
• .filesql/config.json is metadata only — never store credentials, temp paths, or runtime state
• Tables from config start as "Not loaded" — no DuckDB/S3 work until explicit Load
• Only explicit "Save Workspace Configuration" command writes the config file
• Only loaded tables appear in SQL completions and query metadata
• DuckDB engine initialization is deferred until the first table is actually loaded
• Existing ad-hoc flows (addPath, addFolder) are unchanged — those tables are immediately loaded
• All existing tests must continue to pass

After slices 2, 4, and 7: pause and summarize the architecture state for Context Architect review.

Commit frequently with conventional commits (feat:, test:, refactor:).
Do NOT push to main or create a PR — Remy will handle merge after QA sign-off.
```

---

## Success Criteria

- [ ] `.filesql/config.json` is read on activation; declared tables appear as "Not loaded"
- [ ] No DuckDB init / S3 calls until user explicitly loads a table
- [ ] Load / Unload / Reload commands work correctly with state transitions
- [ ] Save Workspace Configuration writes correct, committable JSON
- [ ] Only loaded tables in completions and query webview
- [ ] All existing tests pass (zero regressions)
- [ ] New test coverage ≥ 80% on added code
- [ ] No credentials or machine-specific paths in config file
