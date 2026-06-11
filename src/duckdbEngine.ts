import { DuckDBInstance, DuckDBConnection } from "@duckdb/node-api";
import { ColumnInfo, FileType, QueryResult, TableEntry } from "./types";
import { log, logError } from "./logger";

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
    );
    await this.exec(viewSql);
  }

  async executeQuery(sql: string, maxRows: number): Promise<QueryResult> {
    log(
      `Executing query: ${sql.substring(0, 100)}${sql.length > 100 ? "..." : ""}`,
    );
    const wrapped = `SELECT * FROM (${sql.replace(/;+\s*$/, "")}) __q LIMIT ${maxRows + 1}`;
    const reader = await this.conn.runAndReadAll(wrapped);
    const allRows = reader.getRowObjects() as Record<string, unknown>[];
    const truncated = allRows.length > maxRows;
    const sliced = truncated ? allRows.slice(0, maxRows) : allRows;

    // DuckDB returns BigInt for integer columns — JSON.stringify (used by
    // VS Code postMessage) cannot serialize BigInt, so convert them here.
    const sanitized = sliced.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        if (typeof v === "bigint") {
          out[k] =
            v >= BigInt(Number.MIN_SAFE_INTEGER) &&
            v <= BigInt(Number.MAX_SAFE_INTEGER)
              ? Number(v)
              : String(v);
        } else {
          out[k] = v;
        }
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

  private buildViewSql(name: string, path: string, type: FileType): string {
    let readExpr: string;
    switch (type) {
      case "csv":
        readExpr = `read_csv('${path}', AUTO_DETECT=TRUE)`;
        break;
      case "json":
        readExpr = `read_json_auto('${path}')`;
        break;
      case "parquet":
        readExpr = `read_parquet('${path}')`;
        break;
      case "text":
        readExpr = `read_csv('${path}', DELIM='\n', COLUMNS={'line':'VARCHAR'})`;
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
