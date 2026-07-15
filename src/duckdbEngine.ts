import { DuckDBInstance, DuckDBConnection, StatementType } from "@duckdb/node-api";
import { ColumnInfo, ExportFormat, FileType, QueryResult, TableEntry } from "./types";
import { log, logError } from "./logger";

/** Escape a string for use inside a SQL single-quoted literal. */
function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
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

  async init(): Promise<void> {
    this.instance = await DuckDBInstance.create(":memory:");
    this.conn = await this.instance.connect();
    this.ready = true;
  }

  async configureS3(
    keyId: string,
    secret: string,
    token: string | undefined,
    region: string,
  ): Promise<void> {
    await this.exec(`INSTALL httpfs`);
    await this.exec(`LOAD httpfs`);
    await this.exec(`SET s3_region='${region}'`);
    await this.exec(`SET s3_access_key_id='${keyId}'`);
    await this.exec(`SET s3_secret_access_key='${secret}'`);
    if (token) {
      await this.exec(`SET s3_session_token='${token}'`);
    }
  }

  async registerTable(entry: TableEntry): Promise<ColumnInfo[]> {
    const viewSql = this.buildViewSql(
      entry.name,
      entry.filePath,
      entry.fileType,
      entry.hivePartitioning,
    );
    log(`Registering table "${entry.name}" from ${entry.filePath}`);
    await this.exec(viewSql);
    const cols = await this.introspectColumns(entry.name);
    log(`Table "${entry.name}" registered with ${cols.length} column(s)`);
    return cols;
  }

  async dropTable(name: string): Promise<void> {
    await this.exec(`DROP VIEW IF EXISTS "${name}"`);
  }

  async renameTable(oldName: string, entry: TableEntry): Promise<void> {
    await this.exec(`DROP VIEW IF EXISTS "${oldName}"`);
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
    let readExpr: string;
    switch (type) {
      case "csv":
        readExpr = `read_csv('${path}', AUTO_DETECT=TRUE${hivePartitioning ? ", hive_partitioning=true" : ""})`;
        break;
      case "json":
        readExpr = `read_json_auto('${path}'${hivePartitioning ? ", hive_partitioning=true" : ""})`;
        break;
      case "parquet":
        readExpr = hivePartitioning
          ? `read_parquet('${path}', hive_partitioning=true)`
          : `read_parquet('${path}')`;
        break;
      case "text":
        readExpr = `read_csv('${path}', HEADER=FALSE, COLUMNS={'line':'VARCHAR'}${hivePartitioning ? ", hive_partitioning=true" : ""})`;
        break;
    }
    return `CREATE OR REPLACE VIEW "${name}" AS SELECT * FROM ${readExpr}`;
  }

  private async introspectColumns(tableName: string): Promise<ColumnInfo[]> {
    const reader = await this.conn.runAndReadAll(`DESCRIBE "${tableName}"`);
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
    try {
      this.conn?.closeSync();
    } catch {}
  }
}
