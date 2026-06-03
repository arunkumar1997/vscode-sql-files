# file-sql — Architecture

## Overview

A VS Code extension that lets you load local and S3 files (CSV, JSON, Parquet, text), register them as DuckDB tables, and query them with SQL via a webview editor.

## Component Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│  VS Code Extension Host (Node.js)                                    │
│                                                                      │
│  extension.ts ──── activates, wires all components                  │
│       │                                                              │
│       ├── TableRegistry   in-memory Map + EventEmitter               │
│       │                   add / remove / rename / clear              │
│       │                                                              │
│       ├── DuckDBEngine    :memory: DuckDB instance                   │
│       │                   registerTable / renameTable / executeQuery │
│       │                                                              │
│       ├── Commands                                                   │
│       │    ├── addPath.ts          local file/dir or s3:// URI       │
│       │    ├── addFolder.ts        folder picker → scanFolder        │
│       │    ├── openQueryEditor.ts  WebviewPanel lifecycle            │
│       │    └── clearTables.ts      remove / rename / clear all       │
│       │                                                              │
│       ├── Providers                                                  │
│       │    ├── tablesTreeProvider.ts   sidebar TreeView              │
│       │    └── completionProvider.ts  VS Code SQL completions        │
│       │                                                              │
│       └── Utilities                                                  │
│            ├── fileScanner.ts   type detect, folder walk             │
│            └── s3Handler.ts     region detect, AWS SDK download      │
│                                                                      │
│  ──────────────────────── postMessage ─────────────────────────────  │
│                                                                      │
│  Webview  (browser sandbox — IIFE bundle)                            │
│       ├── App.tsx          root, message bridge, sqlRef sync         │
│       ├── Toolbar.tsx      Run button, row count, truncation warn    │
│       ├── QueryEditor.tsx  CodeMirror 6 + onChange → sqlRef          │
│       └── ResultsTable.tsx data grid                                 │
└──────────────────────────────────────────────────────────────────────┘
```

## Data Flows

### 1 — Load local file or folder
```
addPath / addFolder
  → fileScanner.entryFromLocalFile | scanFolder   → TableEntry[]
  → DuckDBEngine.registerTable  (CREATE VIEW "name" AS SELECT * FROM read_*(path))
  → DuckDBEngine.introspectColumns  (DESCRIBE "name")
  → TableRegistry.add  →  EventEmitter fires
  → TablesTreeProvider refreshes sidebar
  → openQueryEditor pushes tablesChanged → webview
```

### 2 — Load S3 path (file or folder)
```
addPath  detects s3:// prefix
  → resolveAwsCredentials(profile)   fromIni from ~/.aws/credentials
  → detectBucketRegion(bucket)       GetBucketLocation from us-east-1 endpoint
  │                                  returns actual region (e.g. eu-north-1)
  ├── if folder URI (ends with /)
  │     → listS3Keys            ListObjectsV2Command
  │     → downloadS3Folder      streams each part file to
  │                             $TMPDIR/file-sql-XXXX/<folderName>/<filename>
  │                             returns ONE TableEntry:
  │                               name     = deriveTableName(folderName)
  │                               filePath = $TMPDIR/.../folderName/*.parquet
  │                               sourceUri = original s3:// URI  (shown in UI)
  │
  └── if single file URI
        → downloadS3Entries     streams file to $TMPDIR/file-sql-XXXX/
                                returns ONE TableEntry
                                  filePath = local temp path

  → DuckDBEngine.registerTable  reads local file / glob (no httpfs)
  → cleanupTempDir() called on extension deactivate
```

### 3 — Run query
```
Webview  Ctrl+Enter or Run button
  → EditorView.updateListener fires onChange → App.sqlRef updated on each keystroke
  → postMessage { type: 'runQuery', payload: { sql } }
  → openQueryEditor receives message
  → DuckDBEngine.executeQuery
      SELECT * FROM (<sql stripped of trailing ;>) __q LIMIT <maxRows+1>
  → QueryResult { columns, rows, rowCount, truncated }
  → postMessage { type: 'queryResult' }  →  ResultsTable renders
```

### 4 — Rename table
```
Right-click TableNode → "Rename Table"
  → showInputBox  (pre-filled, validated: non-empty, alphanumeric/_, unique)
  → TableRegistry.rename(oldName, newName)   updates entry.name in Map
  → DuckDBEngine.renameTable(oldName, entry)
        DROP VIEW IF EXISTS "oldName";
        CREATE OR REPLACE VIEW "newName" AS SELECT * FROM read_*(...);
  → EventEmitter fires → sidebar + webview tablesChanged
  (on engine failure: registry rename is rolled back)
```

## Key Interfaces (`src/types.ts`)

| Field / Type     | Description                                                      |
| ---------------- | ---------------------------------------------------------------- |
| `TableEntry`     | `name`, `filePath` (local path or glob), `fileType`, `isS3`, `sourceUri?` (original s3:// URI for display), `columns?` |
| `QueryResult`    | `columns`, `rows`, `rowCount`, `truncated`                       |
| `WebviewMessage` | discriminated union: `runQuery` / `tablesChanged` / `queryResult` / `queryError` / `ready` |

## Webview Security (CSP)

VS Code webviews block scripts unless the CSP matches exactly. The correct pattern:

```typescript
// A fresh nonce per panel open
const nonce = randomAlphanumeric(32);
const csp = webview.cspSource;   // e.g. vscode-webview-resource://...

// In HTML:
// <meta http-equiv="Content-Security-Policy"
//   content="default-src 'none';
//            img-src ${csp} data:;
//            style-src ${csp} 'unsafe-inline';
//            script-src 'nonce-${nonce}';" />
// <script nonce="${nonce}" src="${scriptUri}"></script>
```

Using a raw file URI in `script-src` (without nonce) silently blocks the script — the webview renders blank.

## Build System

Two esbuild bundles produced by `esbuild.mjs`:

| Bundle         | Entry                  | Output              | Platform                                          |
| -------------- | ---------------------- | ------------------- | ------------------------------------------------- |
| Extension host | `src/extension.ts`     | `dist/extension.js` | Node CJS — `duckdb` externalized (native `.node`) |
| Webview        | `src/webview/main.tsx` | `dist/webview.js`   | Browser IIFE — CSS extracted to `dist/webview.css`|

```bash
npm run build   # one-shot
npm run watch   # incremental
```

## Project Structure

```
file-sql/
├── PLAN.md
├── ARCHITECTURE.md            ← this file
├── package.json               ← manifest, commands, views, config, deps
├── tsconfig.json              ← extension host (excludes src/webview/**)
├── tsconfig.webview.json      ← webview React (jsx: react-jsx)
├── esbuild.mjs                ← dual-bundle build script
├── .vscodeignore              ← excludes src/, node_modules/ from .vsix
├── .vscode/
│   ├── launch.json            ← F5 extensionHost debug
│   └── tasks.json             ← default build task
├── media/
│   └── database.svg           ← activity bar icon
└── src/
    ├── extension.ts           ← activate / deactivate / cleanupTempDir
    ├── types.ts               ← TableEntry, QueryResult, WebviewMessage
    ├── tableRegistry.ts       ← Map + EventEmitter (add/remove/rename/clear)
    ├── duckdbEngine.ts        ← init / registerTable / renameTable / executeQuery
    ├── fileScanner.ts         ← detectFileType / deriveTableName / scanFolder
    ├── s3Handler.ts           ← resolveAwsCredentials / detectBucketRegion /
    │                             listS3Keys / downloadS3File /
    │                             downloadS3Folder / downloadS3Entries /
    │                             ensureTempDir / cleanupTempDir
    ├── providers/
    │   ├── tablesTreeProvider.ts  ← TreeDataProvider (tooltip = sourceUri)
    │   └── completionProvider.ts ← VS Code CompletionItemProvider
    ├── commands/
    │   ├── addPath.ts         ← local or s3:// (folder → 1 table via glob)
    │   ├── addFolder.ts       ← OS folder picker
    │   ├── openQueryEditor.ts ← WebviewPanel, CSP nonce, message relay
    │   └── clearTables.ts     ← removeTable / renameTable / clearTables
    └── webview/
        ├── main.tsx           ← React createRoot entry
        ├── App.tsx            ← message bridge, state, sqlRef sync
        ├── styles.css         ← VS Code CSS variable theming
        └── components/
            ├── QueryEditor.tsx    ← CodeMirror 6, onChange → sqlRef
            ├── ResultsTable.tsx   ← data grid
            └── Toolbar.tsx        ← Run button, row count, truncation
```

## VS Code Settings

| Setting                 | Default     | Description                              |
| ----------------------- | ----------- | ---------------------------------------- |
| `fileSql.awsProfile`    | `default`   | AWS credentials profile (`~/.aws/...`)   |
| `fileSql.awsRegion`     | `us-east-1` | Fallback only — region is auto-detected  |
| `fileSql.maxResultRows` | `1000`      | Max rows per query (adds `LIMIT N+1`)    |

## Supported File Types

| Extension                    | Type    | DuckDB expression                                                       |
| ---------------------------- | ------- | ----------------------------------------------------------------------- |
| `.csv`, `.tsv`               | csv     | `read_csv('path', AUTO_DETECT=TRUE)`                                    |
| `.json`, `.jsonl`, `.ndjson` | json    | `read_json_auto('path')`                                                |
| `.parquet`                   | parquet | `read_parquet('path')` or `read_parquet('dir/*.parquet')` (folder glob) |
| `.txt`, `.log`               | text    | `read_csv('path', DELIM='\n', COLUMNS={'line':'VARCHAR'})`              |

## S3 Design Decisions

| Decision | Rationale |
|----------|-----------|
| Download-first, no httpfs | DuckDB httpfs fails with 301 redirects on cross-region private buckets; AWS SDK handles retries, region, and auth correctly |
| `GetBucketLocation` for region | Works from any region endpoint; no user config needed |
| Folder → single table + glob | Partitioned datasets (Spark/Hive `part-00000*.parquet`) are logically one table; registering each part file separately is unusable |
| `sourceUri` separate from `filePath` | `filePath` points to local temp path (what DuckDB reads); `sourceUri` preserves original `s3://` URI for display/tooltip |
| Temp dir per session | All downloaded files live in one `mkdtemp` dir; wiped atomically on deactivate |
