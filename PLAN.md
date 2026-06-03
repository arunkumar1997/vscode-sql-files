# file-sql VS Code Extension — Project Plan

## Overview

A VS Code extension to load local and S3 files, query them with SQL, and explore schema via a sidebar.

## Features

- Load **CSV, JSON, Parquet, text** files (local paths or `s3://` URIs)
- **Folder support** — scan a folder and register all supported files as tables
- **S3 folder as single table** — a partitioned dataset folder (e.g. `outcome_per_hw/` containing `part-00000*.parquet`) is registered as **one table** named after the folder; DuckDB glob-reads all part files
- **S3 single file** — a direct file URI registers as a single table
- **AWS profile config** — configurable via VS Code settings (`fileSql.awsProfile`)
- **Auto region detection** — bucket region is detected automatically via `GetBucketLocation`; `fileSql.awsRegion` is no longer required to be correct
- **SQL query engine** — DuckDB in-process (`:memory:`) — Redshift-compatible SQL
- **Left sidebar** — tree view of loaded tables; click to expand columns + types; tooltip shows original `s3://` URI
- **Query editor** — CodeMirror 6 SQL editor in a webview panel (Ctrl+Enter or Run button)
- **Results panel** — tabular results grid with row count and truncation warning
- **SQL auto-completion** — table names, column names (both in CodeMirror and VS Code language completions)
- **Rename table** — right-click a table in the sidebar to rename it

## Tech Stack

| Layer          | Choice                                                        |
| -------------- | ------------------------------------------------------------- |
| SQL Engine     | `duckdb` Node.js native (`:memory:` — no httpfs)              |
| S3 Download    | `@aws-sdk/client-s3` v3 — streams files to OS temp dir        |
| S3 Credentials | `@aws-sdk/credential-providers` v3 (`fromIni` / AWS profiles) |
| Webview UI     | React 18 + TypeScript                                         |
| SQL Editor     | CodeMirror 6 (`@codemirror/lang-sql`, `@codemirror/commands`) |
| Bundler        | esbuild (2 targets: extension host CJS + webview IIFE)        |

> **Note:** DuckDB httpfs was evaluated but dropped. Private buckets and cross-region redirects (301) make httpfs unreliable. The AWS SDK handles auth, region, and retries correctly; DuckDB reads the downloaded local files.

## S3 URI Format

```
s3://bucket/dev/path/to/folder/          ← folder  → 1 table named "folder"
s3://bucket/dev/path/to/file.parquet     ← file    → 1 table named "file"
```

### Folder behaviour (partitioned datasets)

```
s3://.../outcome_per_hw/
  part-00000-abc.snappy.parquet
  part-00001-abc.snappy.parquet
  part-00002-abc.snappy.parquet
```

→ downloads to `$TMPDIR/file-sql-XXXXX/outcome_per_hw/`  
→ DuckDB VIEW: `read_parquet('$TMPDIR/file-sql-XXXXX/outcome_per_hw/*.parquet')`  
→ one table: `outcome_per_hw`

## VS Code Settings

| Setting                 | Default     | Description                   |
| ----------------------- | ----------- | ----------------------------- |
| `fileSql.awsProfile`    | `default`   | AWS credentials profile name  |
| `fileSql.awsRegion`     | `us-east-1` | Fallback only — auto-detected |
| `fileSql.maxResultRows` | `1000`      | Max rows returned per query   |

## Project Structure

```
file-sql/
├── PLAN.md
├── ARCHITECTURE.md
├── package.json               # Extension manifest + dependencies
├── tsconfig.json              # Extension host TS config
├── tsconfig.webview.json      # Webview React TS config
├── esbuild.mjs                # Build script (2 bundles)
├── .vscodeignore              # Excludes src/, node_modules/ from .vsix
├── .vscode/
│   ├── launch.json            # F5 debug config
│   └── tasks.json             # Build task
├── media/
│   └── database.svg           # Activity bar icon
└── src/
    ├── extension.ts           # activate() / deactivate() + temp dir cleanup
    ├── types.ts               # Shared TypeScript interfaces
    ├── tableRegistry.ts       # In-memory table store (rename, remove, clear)
    ├── duckdbEngine.ts        # DuckDB wrapper (init, register, rename, query)
    ├── s3Handler.ts           # AWS SDK: credentials, region detect, download
    ├── fileScanner.ts         # Folder scan + file type detection
    ├── providers/
    │   ├── tablesTreeProvider.ts   # Sidebar TreeDataProvider
    │   └── completionProvider.ts   # VS Code SQL auto-complete
    ├── commands/
    │   ├── addPath.ts         # Add local or s3:// path/folder
    │   ├── addFolder.ts       # Browse and scan local folder
    │   ├── openQueryEditor.ts # Webview panel (CSP nonce, message bridge)
    │   └── clearTables.ts     # Clear all / remove / rename table
    └── webview/
        ├── main.tsx           # React entry point
        ├── App.tsx            # Root component + message handling + sqlRef sync
        ├── components/
        │   ├── QueryEditor.tsx    # CodeMirror 6 + onChange → sqlRef sync
        │   ├── ResultsTable.tsx   # Results data grid
        │   └── Toolbar.tsx        # Run button, row count, truncation warning
        └── styles.css             # VS Code CSS variable theming
```

## Key Commands

| Command                            | Description                                                       |
| ---------------------------------- | ----------------------------------------------------------------- |
| `File SQL: Add Path (Local or S3)` | Input box — local path or `s3://` URI (file or folder)            |
| `File SQL: Add Folder`             | Folder picker — scans and registers all supported files           |
| `File SQL: Open Query Editor`      | Opens the SQL editor + results webview                            |
| `File SQL: Clear All Tables`       | Removes all loaded tables                                         |
| `Remove Table` _(right-click)_     | Remove a single table from the sidebar                            |
| `Rename Table` _(right-click)_     | Rename a table — validates name, updates DuckDB VIEW and registry |

## Supported File Types

| Extension                    | Detected As | DuckDB Function                                            |
| ---------------------------- | ----------- | ---------------------------------------------------------- |
| `.csv`, `.tsv`               | csv         | `read_csv('path', AUTO_DETECT=TRUE)`                       |
| `.json`, `.jsonl`, `.ndjson` | json        | `read_json_auto('path')`                                   |
| `.parquet`                   | parquet     | `read_parquet('path')` or `read_parquet('dir/*.parquet')`  |
| `.txt`, `.log`               | text        | `read_csv('path', DELIM='\n', COLUMNS={'line':'VARCHAR'})` |

## Implementation Order (completed)

1. Project scaffold (package.json, tsconfig, esbuild, .vscode, .vscodeignore)
2. `types.ts` + `tableRegistry.ts` (with `rename` method)
3. `duckdbEngine.ts` — init, registerTable, renameTable, executeQuery
4. `fileScanner.ts` — type detection, folder scan, table name derivation
5. `s3Handler.ts` — credential resolution, region detection, download-first S3
6. `tablesTreeProvider.ts` — sidebar tree (tooltip shows `sourceUri`)
7. Commands — addPath, addFolder, openQueryEditor, clearTables, renameTable
8. `extension.ts` — wire everything, cleanup temp dir on deactivate
9. React webview — App (sqlRef sync), QueryEditor (onChange), ResultsTable, Toolbar
10. `completionProvider.ts` — VS Code SQL auto-complete

## Post-Implementation Fixes

| Issue                                          | Fix                                                                     |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| S3 httpfs 301 redirect / private bucket auth   | Switched to AWS SDK download-first; no httpfs                           |
| S3 wrong region error                          | `detectBucketRegion` via `GetBucketLocation` — auto-detects real region |
| S3 folder created N tables (one per part file) | Folder → 1 table named after folder, DuckDB glob reads all parts        |
| Webview blank (React not rendering)            | CSP: `webview.cspSource` + per-request nonce on `<script>` tag          |
| Run button executed stale query                | `EditorView.updateListener` → `onChange` → `sqlRef` kept in sync        |
