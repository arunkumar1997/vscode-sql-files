import * as duckdb from "duckdb";
import { ColumnInfo, FileType, QueryResult, TableEntry } from "./types";
import { log, logError } from "./logger";

export class DuckDBEngine {
  private db!: duckdb.Database;
  private conn!: duckdb.Connection;
  private ready = false;

  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db = new duckdb.Database(":memory:", (err) => {
        if (err) {
          reject(err);
          return;
        }
        this.conn = this.db.connect();
        this.ready = true;
        resolve();
      });
    });
  }

  async configureS3(
    keyId: string,
    secret: string,
    token: string | undefined,
    region: string,
  ): Promise<void> {
    await this.exec(`INSTALL httpfs; LOAD httpfs;`);
    await this.exec(`SET s3_region='${region}';`);
    await this.exec(`SET s3_access_key_id='${keyId}';`);
    await this.exec(`SET s3_secret_access_key='${secret}';`);
    if (token) {
      await this.exec(`SET s3_session_token='${token}';`);
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
    await this.exec(`DROP VIEW IF EXISTS "${name}";`);
  }

  async renameTable(oldName: string, entry: TableEntry): Promise<void> {
    await this.exec(`DROP VIEW IF EXISTS "${oldName}";`);
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
    const rows = await this.all<Record<string, unknown>>(wrapped);
    const truncated = rows.length > maxRows;
    const sliced = truncated ? rows.slice(0, maxRows) : rows;

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

    const columns: ColumnInfo[] =
      sanitized.length > 0
        ? Object.keys(sanitized[0]).map((name) => ({ name, type: "VARCHAR" }))
        : [];

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
    return `CREATE OR REPLACE VIEW "${name}" AS SELECT * FROM ${readExpr};`;
  }

  private async introspectColumns(tableName: string): Promise<ColumnInfo[]> {
    const rows = await this.all<{ column_name: string; column_type: string }>(
      `DESCRIBE "${tableName}";`,
    );
    return rows.map((r) => ({ name: r.column_name, type: r.column_type }));
  }

  private exec(sql: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.conn.exec(sql, (err) => {
        if (err) {
          logError(`Execution failed: ${sql.substring(0, 100)}`, err);
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  private all<T>(sql: string): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.conn.all(sql, (err, rows) =>
        err ? reject(err) : resolve(rows as T[]),
      );
    });
  }

  isReady(): boolean {
    return this.ready;
  }

  dispose(): void {
    try {
      this.conn?.close();
      this.db?.close(() => {});
    } catch {}
  }
}
