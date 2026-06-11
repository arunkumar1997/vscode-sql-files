# File SQL — Query Local & S3 Files with SQL in VS Code

[![VS Code Extension](https://img.shields.io/badge/VS%20Code-Extension-007ACC?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com)
[![Powered by DuckDB](https://img.shields.io/badge/Powered%20by-DuckDB-FFF000?logo=duckdb&logoColor=black)](https://duckdb.org)
[![TypeScript](https://img.shields.io/badge/Built%20with-TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e)](LICENSE)

**File SQL** turns your local and Amazon S3 files into queryable SQL tables — right inside VS Code. Load CSV, JSON, Parquet, or plain-text files, and run SQL queries against them instantly using [DuckDB](https://duckdb.org)'s high-performance analytics engine. No databases, no ETL pipelines, no setup.

![File SQL Query Editor Screenshot](media/sample.png)

---

## ✨ Features

### 📂 Load Any Data Source

| Source | How |
|---|---|
| **Local file** | Enter a file path — CSV, JSON, Parquet, or text |
| **Local folder** | Pick a folder and register every supported file as a table |
| **S3 single file** | Enter `s3://bucket/path/to/file.csv` |
| **S3 partitioned folder** | Enter `s3://bucket/path/to/folder/` — all part-files are registered as **one table** |

### 🔍 SQL Query Editor

- **CodeMirror 6** editor with SQL syntax highlighting and the **One Dark** theme
- **Autocomplete** for table names, column names, and SQL keywords
- **Run full query** — click ▶ Run or press `Ctrl+Enter`
- **Run selected text** — highlight a portion of SQL and press `Ctrl+Enter` to execute only that snippet
- **Multi-tab queries** — open multiple query tabs, rename them by double-clicking, and switch between them

### 📊 Results Grid

- Tabular results displayed directly below the editor
- Row count shown in the toolbar
- Truncation warning when results exceed the configured `maxResultRows` limit
- **Alt+Click** any header or cell to copy its value to the clipboard

### 🗂️ Sidebar Explorer

- Tree view listing all loaded tables with expandable column details (name + type)
- **Right-click** a table to **Rename**, **Remove**, **Copy Table Name**
- **Right-click** a column to **Copy Column Name**
- S3-sourced tables show the original `s3://` URI as a tooltip

### 📐 Resizable Editor

- Drag the horizontal divider between the editor and results panel to resize
- Minimum height of 80 px, maximum stretches to fill the window

### ☁️ S3 Integration

- **Download-first architecture** — files are streamed from S3 to a local temp directory, then read by DuckDB (avoids httpfs redirect/auth issues)
- **Auto region detection** — bucket region is resolved via `GetBucketLocation`; the `fileSql.awsRegion` setting is only a fallback
- **AWS profile support** — reads credentials from `~/.aws/credentials` using the profile set in `fileSql.awsProfile`
- **Partitioned datasets** — an S3 folder containing `part-*.parquet` files is registered as a single table with a DuckDB glob read
- Temp files are cleaned up automatically when the extension deactivates

---

## 📦 Supported File Formats

| Extension | Detected As | DuckDB Expression |
|---|---|---|
| `.csv`, `.tsv` | CSV | `read_csv('path', AUTO_DETECT=TRUE)` |
| `.json`, `.jsonl`, `.ndjson` | JSON | `read_json_auto('path')` |
| `.parquet` | Parquet | `read_parquet('path')` or `read_parquet('dir/*.parquet')` for folders |
| `.txt`, `.log` | Text | `read_csv('path', DELIM='\n', COLUMNS={'line':'VARCHAR'})` |

---

## 🚀 Quick Start

### 1. Install

1. Open **VS Code** → **Extensions** (`Ctrl+Shift+X` / `Cmd+Shift+X`)
2. Search for **"File SQL"**
3. Click **Install**

**Requirements:** VS Code 1.85.0+

### 2. Load Data

Open the **File SQL** sidebar (database icon in the Activity Bar), then:

- Click the **＋** icon → enter a local path (`/data/sales.csv`) or S3 URI (`s3://bucket/data.parquet`)
- Click the **📁** icon → pick a local folder to import all supported files

### 3. Query

- Click the **▶** icon in the sidebar (or run **File SQL: Open Query Editor** from the Command Palette)
- Write SQL and press **Ctrl+Enter**:

```sql
SELECT region, SUM(revenue) AS total_revenue
FROM sales
WHERE year >= 2024
GROUP BY region
ORDER BY total_revenue DESC;
```

### 4. Explore Results

- Results appear in a table below the editor
- Open additional tabs with the **＋** button in the tab bar
- Rename tabs by double-clicking their label

---

## ⚙️ Configuration

All settings are under **Settings → File SQL**:

| Setting | Default | Description |
|---|---|---|
| `fileSql.awsProfile` | `default` | AWS credentials profile name from `~/.aws/credentials` |
| `fileSql.awsRegion` | `us-east-1` | Fallback region — actual region is auto-detected via `GetBucketLocation` |
| `fileSql.maxResultRows` | `1000` | Maximum rows returned per query (DuckDB wraps your query in `LIMIT N+1`) |

```json
{
  "fileSql.awsProfile": "production",
  "fileSql.awsRegion": "eu-west-1",
  "fileSql.maxResultRows": 5000
}
```

---

## 🛠️ Commands

Available via the **Command Palette** (`Cmd+Shift+P` / `Ctrl+Shift+P`):

| Command | Description |
|---|---|
| **File SQL: Add Path (Local or S3)** | Load a local file/folder or S3 URI |
| **File SQL: Add Folder** | Open a folder picker and register all supported files |
| **File SQL: Open Query Editor** | Open the SQL editor webview panel |
| **File SQL: Clear All Tables** | Remove every loaded table |

Right-click context menu on sidebar items:

| Action | Available On | Description |
|---|---|---|
| **Copy Table Name** | Table node | Copy the table name to clipboard |
| **Rename Table** | Table node | Rename to a valid identifier (alphanumeric + underscores) |
| **Remove Table** | Table node | Unload a single table |
| **Copy Column Name** | Column node | Copy the column name to clipboard |

---

## 🔐 AWS S3 Setup

### Prerequisites

- **AWS CLI** installed and configured — [Installation guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
- IAM user with `s3:GetObject`, `s3:ListBucket`, and `s3:GetBucketLocation` permissions

### Configure Credentials

```bash
# Option 1: AWS CLI profile (recommended)
aws configure --profile my-profile

# Option 2: Environment variables
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=wJalr...
```

Then set `fileSql.awsProfile` to `my-profile` in VS Code settings.

### S3 URI Patterns

```
s3://bucket/path/to/file.parquet       → 1 table named "file"
s3://bucket/path/to/folder/            → 1 table named "folder" (glob reads all part-files)
```

---

## 📋 SQL Examples

### Basic Query
```sql
SELECT * FROM employees
WHERE department = 'Engineering'
ORDER BY hire_date DESC;
```

### Join Tables from Different Sources
```sql
SELECT o.order_id, c.name, o.total
FROM orders o
JOIN customers c ON o.customer_id = c.id
WHERE o.total > 100;
```

### Aggregate Parquet Data
```sql
SELECT
  DATE_TRUNC('month', event_date) AS month,
  COUNT(*) AS events,
  AVG(duration) AS avg_duration
FROM event_logs
GROUP BY month
ORDER BY month;
```

### DuckDB-Specific Features
```sql
-- JSON extraction
SELECT json_extract(payload, '$.user.name') AS user_name
FROM api_logs;

-- Unnest arrays
SELECT unnest(tags) AS tag, COUNT(*) AS cnt
FROM articles
GROUP BY tag;

-- Window functions
SELECT name, salary,
  RANK() OVER (PARTITION BY department ORDER BY salary DESC) AS dept_rank
FROM employees;
```

See the full [DuckDB SQL documentation](https://duckdb.org/docs/sql/introduction.html) for more.

---

## 💡 Tips

- **Filter early** — use `WHERE` to reduce the data DuckDB processes
- **Prefer Parquet** — columnar format is significantly faster than CSV for large datasets
- **Adjust row limit** — increase `fileSql.maxResultRows` if you need to see more results, decrease it to save memory
- **S3 folder = one table** — point to a partitioned dataset folder and File SQL registers it as a single queryable table
- **Alt+Click cells** — quickly copy any value from the results grid

---

## 🔧 Troubleshooting

### Extension Not Activating
- Verify VS Code ≥ 1.85.0
- Reload the window: `Cmd+Shift+P` → **Developer: Reload Window**

### S3 Import Fails
- Confirm credentials: `aws sts get-caller-identity --profile your-profile`
- Check IAM permissions: `s3:GetObject`, `s3:ListBucket`, `s3:GetBucketLocation`
- Ensure the S3 path format is correct (`s3://bucket/key`)
- The region is auto-detected — the `fileSql.awsRegion` setting is a fallback only

### Query Returns an Error
- Verify table and column names in the sidebar explorer
- DuckDB SQL is PostgreSQL-compatible — check [DuckDB docs](https://duckdb.org/docs/sql/introduction.html) for syntax

### Results Truncated
- The `⚠ results truncated` warning means your query returned more rows than `fileSql.maxResultRows`
- Increase the limit in settings, or add `LIMIT` / `WHERE` clauses to narrow your query

---

## 🏗️ Development

```bash
# Clone the repository
git clone https://github.com/arunkumar1997/vscode-sql-files.git
cd vscode-sql-files

# Install dependencies
npm install

# Build (one-shot)
npm run build

# Watch mode (incremental rebuilds)
npm run watch

# Debug — press F5 in VS Code to launch Extension Development Host
```

### Build System

Two esbuild bundles are produced by `esbuild.mjs`:

| Bundle | Entry | Output | Platform |
|---|---|---|---|
| Extension host | `src/extension.ts` | `dist/extension.js` | Node.js CJS (`duckdb` externalized) |
| Webview | `src/webview/main.tsx` | `dist/webview.js` + `dist/webview.css` | Browser IIFE |

### Packaging & Release

File SQL ships as **platform-specific VSIX files** — one per supported `(os, arch)` — because DuckDB's native bindings are not portable. The VS Code Marketplace serves the correct VSIX to each user automatically.

Supported targets:

| VS Code target  | Built on (CI)      |
|-----------------|--------------------|
| `win32-x64`     | `windows-latest`   |
| `win32-arm64`   | `windows-latest` (cross-installed) |
| `linux-x64`     | `ubuntu-latest`    |
| `linux-arm64`   | `ubuntu-latest` (cross-installed)  |
| `darwin-x64`    | `macos-13`         |
| `darwin-arm64`  | `macos-14`         |

Local packaging:

```bash
# VSIX for the current host (fastest, good for smoke-testing)
npm run package:current

# A specific target (binding is downloaded if missing)
npm run package:target -- linux-x64

# Every supported target — produces 6 files in ./out
npm run package:all
```

Each VSIX is written to `out/file-sql-<target>-<version>.vsix`.

CI builds all 6 VSIX files in parallel on every push to `main` via [`.github/workflows/build.yml`](.github/workflows/build.yml). Download them from the run's **Artifacts** section.

Releases are published manually:

1. Bump `version` in `package.json` and push.
2. Download the 6 VSIX artifacts from the latest CI run.
3. Upload them to https://marketplace.visualstudio.com/manage (drag-and-drop each one as a platform-specific variant of the same version).
4. *(Optional)* Publish to Open VSX with `ovsx publish <file>.vsix -p <OVSX_PAT>` for each VSIX.

---

## 🤝 Contributing

1. **Fork** the repository
2. **Create** a feature branch: `git checkout -b feature/your-feature`
3. **Commit** your changes: `git commit -m "Add your feature"`
4. **Push** to your branch: `git push origin feature/your-feature`
5. **Open** a Pull Request

---

## 🗺️ Roadmap

- [ ] Query result export (CSV, JSON, Parquet)
- [ ] Saved queries and query history persistence
- [ ] Data visualization (charts and graphs)
- [ ] Additional file formats (Excel, Avro, SQLite)

---

## 🙏 Acknowledgments

- [DuckDB](https://duckdb.org) — high-performance in-process SQL analytics engine
- [CodeMirror 6](https://codemirror.net) — extensible code editor component
- [AWS SDK for JavaScript v3](https://aws.amazon.com/sdk-for-javascript/) — S3 client and credential handling
- [VS Code Extension API](https://code.visualstudio.com/api) — extension platform

---

## 📄 License

MIT — see [LICENSE](LICENSE) for details.

---

## 📬 Feedback & Issues

- **Report bugs**: [GitHub Issues](https://github.com/arunkumar1997/vscode-sql-files/issues)
- **Request features**: [GitHub Discussions](https://github.com/arunkumar1997/vscode-sql-files/discussions)

**⭐ If File SQL saves you time, [star the repo](https://github.com/arunkumar1997/vscode-sql-files) — it helps others find it!**
