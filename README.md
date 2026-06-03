# File SQL - Query Local & S3 Files with SQL in VS Code

[![VS Code Extension](https://img.shields.io/badge/Visual%20Studio%20Code-Extension-blue?logo=visualstudiocode)](https://marketplace.visualstudio.com)
[![DuckDB Powered](https://img.shields.io/badge/Powered%20by-DuckDB-336B5C?logo=duckdb)](https://duckdb.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-85.8%25-3178C6?logo=typescript)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)

## Overview

**File SQL** is a powerful VS Code extension that transforms your local and cloud files into queryable databases. Import CSV, JSON, and Parquet files from your local filesystem or Amazon S3 buckets, then execute SQL queries using DuckDB's high-performance analytics engine—without ETL pipelines, data warehouses, or complex setup.

Powered by [DuckDB](https://duckdb.org), a high-performance SQL analytics engine, File SQL brings the convenience of SQL to your file-based data analysis workflow.

## 🚀 Key Features

### File & Folder Support
- **Load Local Files**: Import CSV, JSON, and Parquet files from your local filesystem
- **Import from Amazon S3**: Download and import files from S3 buckets using `s3://bucket/path` syntax
- **Folder Import**: Batch load entire folders and subfolders for bulk data processing
- **Multiple Data Sources**: Mix and match local and imported S3 files in a single query

### SQL Query Editor
- **Intelligent SQL Editor**: CodeMirror-powered editor with syntax highlighting and autocomplete
- **Multi-Tab Support**: Open and manage multiple queries simultaneously
- **Resizable Query Editor**: Adjust editor height for better UX with your preferred layout
- **Tabbed Query Management**: Name, organize, and switch between queries effortlessly
- **Select & Execute**: Run only selected SQL statements (perfect for testing snippets)

### Schema Exploration & Data Discovery
- **View Table Schema**: Inspect column names, data types, and structure instantly
- **Copy Column Names**: Click to copy column names—no more manual typing
- **Copy Table Names**: Quickly reference table names in your queries
- **Interactive Table Explorer**: Tree-view visualization of all loaded tables and columns
- **Rename Tables**: Alias imported tables with custom names for cleaner, readable queries

### Query Results
- **Interactive Result Grid**: Browse query results in a searchable, sortable table format
- **Result Limiting**: Configurable row limits to control memory usage (default: 1,000 rows)
- **Export-Ready Data**: Copy results for use in other tools and applications

### AWS S3 Connectivity
- **Secure Import**: Import files from S3 using AWS credential profile support
- **S3 Path Support**: Use `s3://bucket/file.csv` or `s3://bucket/folder/` patterns
- **Profile Management**: Switch between AWS profiles in extension settings
- **Region Configuration**: Set AWS region for S3 access

## 📦 Installation

1. Open **Visual Studio Code**
2. Navigate to the **Extensions** marketplace (Ctrl+Shift+X / Cmd+Shift+X)
3. Search for **"File SQL"** or **"file-sql"**
4. Click **Install**
5. Reload VS Code when prompted

### System Requirements
- VS Code 1.85.0 or later
- Node.js 16+ (for development)
- AWS credentials configured (optional, for S3 file import)

## 🎯 Quick Start

### Step 1: Add a Data Source

Three ways to load data:

#### Option A: Add a Single Local File
1. Click the **+** icon in the File SQL sidebar
2. Select a local file path: `/path/to/data.csv` or `/path/to/data.parquet`
3. The file is imported and loaded as a table

#### Option B: Add a Local Folder
1. Click the **folder** icon in the File SQL sidebar
2. Select a local folder
3. All CSV, JSON, and Parquet files in the folder are imported as individual tables

#### Option C: Import from S3
1. Click the **+** icon and enter an S3 path:
   - Single file: `s3://my-bucket/data/file.csv`
   - Entire folder: `s3://my-bucket/data-folder/`
2. The file(s) are downloaded and imported into your local tables
3. Queries execute locally on the imported data

### Step 2: Explore Your Data

1. In the **File SQL Explorer** panel, expand the **Tables** section
2. View loaded tables and their columns
3. Right-click on any table to:
   - **Rename**: Give tables meaningful names (e.g., `customers_2024`)
   - **Copy Table Name**: Auto-copy to clipboard for use in queries
   - **Copy Column Name**: Right-click columns to copy names
   - **Remove**: Unload a table from memory

### Step 3: Write & Execute Queries

1. Click the **play** icon (or press Cmd+Enter / Ctrl+Enter) to open the Query Editor
2. Write SQL queries:
   ```sql
   SELECT name, email, COUNT(*) as purchase_count
   FROM customers
   GROUP BY name, email
   ORDER BY purchase_count DESC;
   ```
3. **Execute full query**: Click the play button or press Cmd+Enter
4. **Execute selected text**: Highlight specific SQL statements and press Cmd+Enter
5. Results appear in a table below the editor

### Step 4: Manage Multiple Queries

1. Use the **+** button in the query editor to create new tabs
2. Rename tabs by double-clicking the tab name
3. Close tabs with the **×** button
4. Switch between queries instantly

## 📋 SQL Query Examples

### Query Local CSV Files
```sql
SELECT * FROM employees 
WHERE salary > 50000
ORDER BY salary DESC;
```

### Join Local and Imported S3 Data
```sql
SELECT 
  l.order_id,
  l.customer_name,
  s.product_details
FROM local_orders l
LEFT JOIN imported_s3_catalog s ON l.product_id = s.id;
```

### Aggregate Data Imported from S3 Parquet
```sql
SELECT 
  region,
  AVG(revenue) as avg_revenue,
  COUNT(*) as transactions
FROM imported_s3_sales_data
WHERE year = 2024
GROUP BY region;
```

### Union Data from Multiple Sources
```sql
SELECT date, amount, 'Local' as source
FROM local_transactions
UNION ALL
SELECT transaction_date, total, 'Imported from S3' as source
FROM imported_s3_transactions
ORDER BY date DESC;
```

## ⚙️ Configuration

File SQL settings are available in **VS Code Preferences** → **Settings** → **File SQL**.

### Available Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `fileSql.awsProfile` | String | `default` | AWS credentials profile name for importing S3 files |
| `fileSql.awsRegion` | String | `us-east-1` | AWS region for S3 bucket access |
| `fileSql.maxResultRows` | Number | `1000` | Maximum rows returned per query (limits memory usage) |

### Example Configuration
```json
{
  "fileSql.awsProfile": "production",
  "fileSql.awsRegion": "eu-west-1",
  "fileSql.maxResultRows": 5000
}
```

## 🔐 AWS S3 Setup

### Prerequisites
1. **AWS Account** with S3 access
2. **AWS CLI** installed and configured: [Get Started](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
3. **IAM Permissions**: Ensure your AWS user has `s3:GetObject` and `s3:ListBucket` permissions

### Configure AWS Credentials

#### Using AWS CLI (Recommended)
```bash
aws configure --profile your-profile-name
```

#### Using Environment Variables
```bash
export AWS_ACCESS_KEY_ID=your_access_key
export AWS_SECRET_ACCESS_KEY=your_secret_key
export AWS_DEFAULT_REGION=us-east-1
```

### Import Files from S3
1. In VS Code settings, set `fileSql.awsProfile` to your configured profile
2. Click the **+** icon in File SQL Explorer and enter S3 paths:
   ```
   s3://my-bucket/data/file.csv
   s3://my-bucket/data-folder/
   ```
3. Files are automatically downloaded and imported as tables for querying

## 📊 Supported File Formats

| Format | Extension | Support | Notes |
|--------|-----------|---------|-------|
| CSV | `.csv` | ✅ Full | Auto-detects delimiters; supports local and S3 import |
| JSON | `.json`, `.jsonl` | ✅ Full | Supports line-delimited JSON; local and S3 import |
| Parquet | `.parquet`, `.pq` | ✅ Full | Efficient columnar storage; local and S3 import |

## 🛠️ Commands Reference

All File SQL commands are accessible via the **Command Palette** (Cmd+Shift+P / Ctrl+Shift+P):

| Command | Shortcut | Description |
|---------|----------|-------------|
| File SQL: Add Path | — | Load a local file or import from S3 |
| File SQL: Add Folder | — | Load all files from a local folder |
| File SQL: Open Query Editor | Cmd+Enter | Open the SQL query editor |
| File SQL: Clear All Tables | — | Remove all loaded tables from memory |
| File SQL: Rename Table | — | Rename a table for easier queries |
| File SQL: Remove Table | — | Unload a specific table |
| File SQL: Copy Table Name | — | Copy table name to clipboard |
| File SQL: Copy Column Name | — | Copy column name to clipboard |

## 🎨 Editor Features

### Multi-Tab Query Management
- Open unlimited query tabs simultaneously
- Switch between queries with a single click
- Rename tabs for better organization
- Auto-save query state (session-based)

### Resizable Editor
- Drag the editor border to resize vertically
- Optimize screen real estate for your workflow
- Persistent layout preferences

### SQL Autocomplete & Syntax Highlighting
- CodeMirror-powered SQL autocomplete
- One Dark theme for comfortable viewing
- Error detection and inline hints

## 🚀 Use Cases

### Data Analysis & Exploration
- Quickly explore CSV/JSON datasets without loading into external tools
- Prototype SQL queries before running in production databases
- Import S3 data lake files for local analysis

### ETL Prototyping
- Build and test data transformation logic using SQL
- Import and combine multiple data sources in queries
- Validate data quality before warehouse ingestion

### S3 Data Lake Queries
- Import and query data lake files from S3
- Avoid expensive data warehouse costs for ad-hoc analysis
- Combine local and imported cloud data in unified queries

### Business Intelligence
- Generate reports from local and imported data files
- Create aggregates and summaries on-the-fly
- Export results for use in BI tools

### Development & Testing
- Use realistic datasets in development workflows
- Test SQL logic without database setup
- Run selective test queries on large files

## 📈 Performance Tips

1. **Filter Early**: Use WHERE clauses to reduce data loaded
   ```sql
   SELECT * FROM large_file WHERE date > '2024-01-01'
   ```

2. **Limit Results**: Set reasonable `maxResultRows` in settings to avoid memory spikes

3. **Aggregate Before Export**: Pre-aggregate data in queries rather than post-processing
   ```sql
   SELECT category, SUM(sales) FROM data GROUP BY category
   ```

4. **Use Parquet for Large Files**: Parquet files are more efficient than CSV for big datasets

5. **Consider File Size**: Large S3 files will take time to download and import; organize data in S3 by splitting into smaller files when possible

## 🔍 Troubleshooting

### Extension Not Loading
- Ensure VS Code version is 1.85.0 or later
- Reload the window (Cmd+K Cmd+W / Ctrl+K Ctrl+W)

### S3 Import Issues
- Verify AWS credentials are configured: `aws sts get-caller-identity`
- Check IAM permissions include `s3:GetObject` and `s3:ListBucket`
- Confirm AWS region in settings matches your S3 bucket location
- Ensure the S3 path is correct: `s3://bucket-name/path/to/file`

### Query Errors
- Check table names are correctly spelled (case-sensitive in some contexts)
- Verify column names using the Explorer panel
- Review DuckDB SQL documentation for syntax: [DuckDB Docs](https://duckdb.org/docs/sql/introduction.html)

### Memory Issues
- Reduce `maxResultRows` in settings
- Use filters and aggregations in queries
- Close unused query tabs
- Import smaller files or split large S3 files before importing

## 🧪 DuckDB SQL Dialect

File SQL uses [DuckDB SQL](https://duckdb.org/docs/sql/introduction.html), which is compatible with standard SQL but includes powerful extensions:

```sql
-- JSON extraction
SELECT json_extract(data, '$.user.name') FROM json_file;

-- Array operations
SELECT unnest(array_col) FROM data;

-- Date functions
SELECT NOW(), DATE_TRUNC('month', timestamp_col);
```

See [DuckDB SQL Documentation](https://duckdb.org/docs/sql/introduction.html) for advanced features.

## 🤝 Contributing

Contributions are welcome! Please follow these steps:

1. **Fork** the repository
2. **Create** a feature branch: `git checkout -b feature/your-feature`
3. **Commit** changes: `git commit -m "Add your feature"`
4. **Push** to branch: `git push origin feature/your-feature`
5. **Submit** a Pull Request

### Development Setup
```bash
# Clone repository
git clone https://github.com/arunkumar1997/vscode-sql-files.git
cd vscode-sql-files

# Install dependencies
npm install

# Build extension
npm run build

# Watch for changes
npm run watch

# Open in VS Code with F5 to debug
```

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **[DuckDB](https://duckdb.org)** - High-performance SQL analytics engine
- **[CodeMirror](https://codemirror.net)** - Extensible code editor
- **[AWS SDK for JavaScript](https://aws.amazon.com/sdk-for-javascript)** - S3 integration
- **[VS Code Extension API](https://code.visualstudio.com/api)** - Extension platform

## 📞 Support & Feedback

- **Report Issues**: [GitHub Issues](https://github.com/arunkumar1997/vscode-sql-files/issues)
- **Request Features**: [GitHub Discussions](https://github.com/arunkumar1997/vscode-sql-files/discussions)
- **Share Feedback**: Open an issue with the `feedback` label

## 🗺️ Roadmap

- [ ] Support for additional file formats (Excel, Avro, SQLite)
- [ ] Query result export (CSV, JSON, Parquet)
- [ ] Saved queries and query history
- [ ] Data visualization (charts, graphs)
- [ ] Incremental data loading for large files
- [ ] GCS (Google Cloud Storage) support
- [ ] Azure Blob Storage support

---

**⭐ If you find File SQL useful, please star the repository on [GitHub](https://github.com/arunkumar1997/vscode-sql-files) to show your support!**
