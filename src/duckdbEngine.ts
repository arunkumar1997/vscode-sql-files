import { DuckDBInstance, DuckDBConnection, StatementType } from "@duckdb/node-api";
import { ColumnInfo, ExportFormat, FileType, QueryResult, TableEntry } from "./types";
import { log, logError } from "./logger";
import * as crypto from "crypto";

/**
 * Escape a string for use inside a SQL single-quoted literal.
 * Doubles all single-quote characters and rejects NUL bytes.
 */
export function escapeSqlString(value: string): string {
  if (value.includes("\0")) {
    throw new Error("SQL string literal cannot contain NUL bytes");
  }
  return value.replace(/'/g, "''");
}

/**
 * Escape an identifier for use as a DuckDB double-quoted identifier.
 * Doubles all double-quote characters and rejects NUL bytes.
 */
export function escapeDuckDBIdentifier(name: string): string {
  if (!name || name.includes("\0")) {
    throw new Error("DuckDB identifier cannot be empty or contain NUL bytes");
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Statement types that produce row output and can be wrapped in
 * SELECT * FROM (...) LIMIT N for maxRows enforcement.
 */
const WRAPPABLE_ROW_TYPES = new Set<StatementType>([
  StatementType.SELECT,   // includes VALUES, SHOW, DESCRIBE, PRAGMA→SELECT
]);

/**
 * Statement types that produce row output but CANNOT be subqueried.
 * These are executed directly and the result array is truncated.
 */
const DIRECT_ROW_TYPES = new Set<StatementType>([
  StatementType.EXPLAIN,
  StatementType.CALL,
  StatementType.RELATION,
]);

export class DuckDBEngine {
  private instance!: DuckDBInstance;
  private conn!: DuckDBConnection;
  private ready = false;
  private initPromise: Promise<void> | undefined;

  private httpfsLoaded = false;
  /** Active scoped S3 secret names (for cleanup on dispose/unload). */
  private activeSecrets = new Map<string, string>();

  async init(): Promise<void> {
    this.instance = await DuckDBInstance.create(":memory:");
    this.conn = await this.instance.connect();
    this.ready = true;
  }

  /**
   * Per-instance, promise-locked, idempotent initialization.
   * Safe for concurrent callers — only one init runs, all await the same promise.
   * On failure the promise is cleared so a retry is possible.
   */
  async ensureInitialized(): Promise<void> {
    if (this.ready) {
      return;
    }
    if (!this.initPromise) {
      this.initPromise = this.init().catch((err) => {
        this.initPromise = undefined;
        throw err;
      });
    }
    return this.initPromise;
  }

  async configureS3(
    keyId: string,
    secret: string,
    token: string | undefined,
    region: string,
  ): Promise<void> {
    await this.ensureHttpfs();
    await this.exec(`SET s3_region='${escapeSqlString(region)}'`);
    await this.exec(`SET s3_access_key_id='${escapeSqlString(keyId)}'`);
    await this.exec(`SET s3_secret_access_key='${escapeSqlString(secret)}'`);
    if (token) {
      await this.exec(`SET s3_session_token='${escapeSqlString(token)}'`);
    }
  }

  /**
   * Load httpfs extension idempotently.
   */
  async ensureHttpfs(): Promise<void> {
    if (this.httpfsLoaded) return;
    await this.exec(`INSTALL httpfs`);
    await this.exec(`LOAD httpfs`);
    this.httpfsLoaded = true;
  }

  /**
   * Create a temporary scoped S3 secret for range-read mode.
   * Returns the secret name for later cleanup.
   * Uses CREATE OR REPLACE SECRET ... (TYPE S3, PROVIDER config, SCOPE ...).
   * Never logs credential SQL.
   */
  async createScopedS3Secret(
    tableName: string,
    bucket: string,
    prefix: string,
    credentials: { keyId: string; secret: string; token?: string },
    region: string,
  ): Promise<string> {
    await this.ensureHttpfs();
    // Generate unique secret name from table + random suffix
    const suffix = crypto.randomUUID().slice(0, 8);
    const secretName = `filesql_${tableName.replace(/[^a-zA-Z0-9_]/g, "_")}_${suffix}`;
    const scope = `s3://${bucket}/${prefix}`;

    const tokenClause = credentials.token
      ? `\n  SESSION_TOKEN '${escapeSqlString(credentials.token)}',`
      : "";
    const urlStyleClause = bucket.includes(".")
      ? "\n  URL_STYLE 'path',"
      : "";
    const sql = `CREATE OR REPLACE TEMPORARY SECRET "${escapeSqlString(secretName)}" (
  TYPE s3,
  PROVIDER config,
  KEY_ID '${escapeSqlString(credentials.keyId)}',
  SECRET '${escapeSqlString(credentials.secret)}',${tokenClause}
  ${urlStyleClause}
  REGION '${escapeSqlString(region)}',
  SCOPE '${escapeSqlString(scope)}'
)`;

    // Execute but do NOT log the SQL (contains credentials)
    try {
      await this.conn.run(sql);
    } catch (err) {
      logError(`Failed to create S3 secret for table "${tableName}"`, err as Error);
      throw err;
    }

    this.activeSecrets.set(tableName, secretName);
    log(`Created scoped S3 secret for table "${tableName}" (scope: s3://${bucket}/${prefix.substring(0, 20)}...)`);
    return secretName;
  }

  /**
   * Drop a scoped S3 secret by table name (best-effort).
   */
  async dropS3Secret(tableName: string): Promise<void> {
    const secretName = this.activeSecrets.get(tableName);
    if (!secretName) return;
    try {
      await this.exec(`DROP SECRET IF EXISTS "${escapeSqlString(secretName)}"`);
    } catch {
      // Best-effort — secret may already be gone
    }
    this.activeSecrets.delete(tableName);
  }

  /**
   * Register a table as a DuckDB VIEW using range-read (direct S3 read_parquet).
   * The view reads from S3 URI(s) directly — no local download needed.
   * Failure-atomic: drops the view if introspection fails.
   */
  async registerRangeTable(
    entry: TableEntry,
    s3Uris: string[],
    hivePartitioning: boolean,
  ): Promise<ColumnInfo[]> {
    const ident = escapeDuckDBIdentifier(entry.name);
    let readExpr: string;
    if (s3Uris.length === 1) {
      const escapedUri = escapeSqlString(s3Uris[0]);
      readExpr = hivePartitioning
        ? `read_parquet('${escapedUri}', hive_partitioning=true)`
        : `read_parquet('${escapedUri}')`;
    } else {
      const uriList = s3Uris.map((u) => `'${escapeSqlString(u)}'`).join(", ");
      readExpr = hivePartitioning
        ? `read_parquet([${uriList}], hive_partitioning=true)`
        : `read_parquet([${uriList}])`;
    }
    const viewSql = `CREATE OR REPLACE VIEW ${ident} AS SELECT * FROM ${readExpr}`;
    log(`Registering range-read table "${entry.name}" (${s3Uris.length} URI(s))`);
    await this.exec(viewSql);
    try {
      return await this.introspectColumns(entry.name);
    } catch (err) {
      try {
        await this.exec(`DROP VIEW IF EXISTS ${ident}`);
      } catch { /* best-effort rollback */ }
      throw err;
    }
  }

  /**
   * Validate that a range-read view is functional by selecting 0 rows.
   * Throws on failure with the actual DuckDB/httpfs error.
   */
  async validateRangeRead(tableName: string): Promise<void> {
    const ident = escapeDuckDBIdentifier(tableName);
    await this.conn.runAndReadAll(`SELECT 1 FROM ${ident} LIMIT 0`);
  }

  /**
   * Register a table as a DuckDB VIEW. Failure-atomic: if introspection
   * fails after the VIEW is created, the VIEW is rolled back (dropped).
   */
  async registerTable(entry: TableEntry): Promise<ColumnInfo[]> {
    const viewSql = this.buildViewSql(
      entry.name,
      entry.filePath,
      entry.fileType,
      entry.hivePartitioning,
    );
    log(`Registering table "${entry.name}" from ${entry.filePath}`);
    await this.exec(viewSql);
    try {
      return await this.introspectColumns(entry.name);
    } catch (err) {
      // Rollback: drop the view that was just created
      try {
        await this.exec(`DROP VIEW IF EXISTS ${escapeDuckDBIdentifier(entry.name)}`);
      } catch {
        // Best-effort rollback
      }
      throw err;
    }
  }

  async dropTable(name: string): Promise<void> {
    const ident = escapeDuckDBIdentifier(name);
    await this.exec(`DROP VIEW IF EXISTS ${ident}`);
  }

  async renameTable(oldName: string, entry: TableEntry): Promise<void> {
    const oldIdent = escapeDuckDBIdentifier(oldName);
    await this.exec(`DROP VIEW IF EXISTS ${oldIdent}`);
    const viewSql = this.buildViewSql(
      entry.name,
      entry.filePath,
      entry.fileType,
      entry.hivePartitioning,
    );
    await this.exec(viewSql);
  }

  async executeQuery(sql: string, maxRows: number): Promise<QueryResult> {
    log(
      `Executing query: ${sql.substring(0, 100)}${sql.length > 100 ? "..." : ""}`,
    );

    const trimmed = sql.replace(/;+\s*$/, "");

    // Reject multiple statements to prevent surprising trailing execution.
    const extracted = await this.conn.extractStatements(trimmed);
    if (extracted.count > 1) {
      throw new Error(
        `Multiple statements are not supported. Found ${extracted.count} statements; please run one statement at a time.`,
      );
    }

    // Use DuckDB's prepared-statement metadata to classify the statement
    // without executing it. This replaces the keyword-based allowlist with
    // a generic, DuckDB-native mechanism.
    const prepared = await this.conn.prepare(trimmed);
    const stmtType = prepared.statementType;
    prepared.destroySync();

    // Wrappable row-producing statements (SELECT, VALUES, SHOW, DESCRIBE, PRAGMA):
    // wrap in SELECT * FROM (...) LIMIT N for efficient server-side truncation.
    if (WRAPPABLE_ROW_TYPES.has(stmtType)) {
      const wrapped = `SELECT * FROM (${trimmed}) __q LIMIT ${maxRows + 1}`;
      return this.executeAndSerialize(wrapped, maxRows);
    }

    // Non-wrappable row-producing statements (EXPLAIN, CALL, RELATION):
    // execute directly but apply maxRows truncation on the result array.
    if (DIRECT_ROW_TYPES.has(stmtType)) {
      return this.executeAndSerialize(trimmed, maxRows);
    }

    // All other statements (COPY, CREATE, DROP, ALTER, INSERT, UPDATE,
    // DELETE, SET, LOAD, ATTACH, DETACH, EXPORT, VACUUM, etc.):
    // execute directly and return empty result.
    await this.exec(trimmed);
    return { columns: [], rows: [], rowCount: 0, truncated: false };
  }

  /**
   * Run a SQL query, read all results, serialize values for postMessage,
   * and enforce maxRows truncation.
   */
  private async executeAndSerialize(
    sql: string,
    maxRows: number,
  ): Promise<QueryResult> {
    const reader = await this.conn.runAndReadAll(sql);
    const allRows = reader.getRowObjects() as Record<string, unknown>[];
    const truncated = allRows.length > maxRows;
    const sliced = truncated ? allRows.slice(0, maxRows) : allRows;

    // Recursively convert all DuckDB value types to postMessage-safe primitives.
    // DuckDB can return BigInt (integers), Date (timestamps), plain objects
    // (structs), and arrays — none of which survive postMessage or display
    // correctly via String() in the webview.
    function serializeValue(v: unknown): unknown {
      if (v === null || v === undefined) {
        return null;
      }
      if (typeof v === "bigint") {
        return v >= BigInt(Number.MIN_SAFE_INTEGER) &&
          v <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(v)
          : String(v);
      }
      if (v instanceof Date) {
        return v.toISOString();
      }
      if (typeof v === "object") {
        // DuckDB TIMESTAMP / TIMESTAMPTZ / TIME: { micros: bigint }
        // micros = microseconds since Unix epoch
        if (
          "micros" in v &&
          typeof (v as Record<string, unknown>).micros === "bigint"
        ) {
          const micros = (v as { micros: bigint }).micros;
          return new Date(Number(micros / 1000n)).toISOString();
        }
        // DuckDB DATE: { days: number } — days since Unix epoch
        if (
          "days" in v &&
          typeof (v as Record<string, unknown>).days === "number"
        ) {
          const days = (v as { days: number }).days;
          return new Date(days * 86400000).toISOString().slice(0, 10);
        }
        // Structs, arrays, intervals, and other complex types — render as JSON.
        try {
          return JSON.stringify(v, (_k, val) =>
            typeof val === "bigint" ? String(val) : val,
          );
        } catch {
          return String(v);
        }
      }
      return v;
    }

    const sanitized = sliced.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        out[k] = serializeValue(v);
      }
      return out;
    });

    const columnNames = reader.columnNames();
    const columns: ColumnInfo[] = columnNames.map((name) => ({
      name,
      type: "VARCHAR",
    }));

    log(
      `Query returned ${sanitized.length} row(s)${truncated ? " (truncated)" : ""}`,
    );
    return { columns, rows: sanitized, rowCount: sanitized.length, truncated };
  }

  async exportQuery(
    sql: string,
    destination: string,
    format: ExportFormat,
  ): Promise<void> {
    const trimmed = sql.replace(/;+\s*$/, "");
    const escapedDest = escapeSqlString(destination);
    const formatOption = format === "parquet" ? "PARQUET" : "CSV, HEADER";
    const copySql = `COPY (${trimmed}) TO '${escapedDest}' (FORMAT ${formatOption})`;
    log(`Exporting query to ${format}: ${destination}`);
    await this.exec(copySql);
    log(`Export complete: ${destination}`);
  }

  private buildViewSql(
    name: string,
    path: string,
    type: FileType,
    hivePartitioning = false,
  ): string {
    const ident = escapeDuckDBIdentifier(name);
    const escapedPath = escapeSqlString(path);
    let readExpr: string;
    switch (type) {
      case "csv":
        readExpr = `read_csv('${escapedPath}', AUTO_DETECT=TRUE${hivePartitioning ? ", hive_partitioning=true" : ""})`;
        break;
      case "json":
        readExpr = `read_json_auto('${escapedPath}'${hivePartitioning ? ", hive_partitioning=true" : ""})`;
        break;
      case "parquet":
        readExpr = hivePartitioning
          ? `read_parquet('${escapedPath}', hive_partitioning=true)`
          : `read_parquet('${escapedPath}')`;
        break;
      case "text":
        readExpr = `read_csv('${escapedPath}', HEADER=FALSE, COLUMNS={'line':'VARCHAR'}${hivePartitioning ? ", hive_partitioning=true" : ""})`;
        break;
    }
    return `CREATE OR REPLACE VIEW ${ident} AS SELECT * FROM ${readExpr}`;
  }

  private async introspectColumns(tableName: string): Promise<ColumnInfo[]> {
    const ident = escapeDuckDBIdentifier(tableName);
    const reader = await this.conn.runAndReadAll(`DESCRIBE ${ident}`);
    const rows = reader.getRowObjects() as {
      column_name: string;
      column_type: string;
    }[];
    return rows.map((r) => ({ name: r.column_name, type: r.column_type }));
  }

  private async exec(sql: string): Promise<void> {
    try {
      await this.conn.run(sql);
    } catch (err) {
      logError(`Execution failed: ${sql.substring(0, 100)}`, err as Error);
      throw err;
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  dispose(): void {
    // Best-effort cleanup of active S3 secrets
    for (const secretName of this.activeSecrets.values()) {
      try {
        this.conn?.run(`DROP SECRET IF EXISTS "${escapeSqlString(secretName)}"`);
      } catch { /* best-effort */ }
    }
    this.activeSecrets.clear();
    try {
      this.conn?.closeSync();
    } catch {
      // Disposal is best-effort during extension shutdown and test cleanup.
    }
  }
}
