import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import { createEngine, EngineHarness } from "../helpers/duckdbHarness";
import { createTempDir, TempDir } from "../helpers/tempDir";
import { TableEntry } from "../../src/types";

const FIXTURES = path.resolve(__dirname, "../fixtures");

describe("Engine — exportQuery", () => {
  let harness: EngineHarness;
  let tmp: TempDir;

  afterEach(() => {
    harness?.dispose();
    tmp?.cleanup();
  });

  it("exports a SELECT query to CSV", async () => {
    harness = await createEngine();
    const entry: TableEntry = {
      name: "sales",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
    };
    await harness.engine.registerTable(entry);

    tmp = createTempDir();
    const dest = path.join(tmp.path, "out.csv");
    await harness.engine.exportQuery(
      "SELECT * FROM sales ORDER BY id",
      dest,
      "csv",
    );

    expect(fs.existsSync(dest)).toBe(true);
    const content = fs.readFileSync(dest, "utf-8");
    // CSV header + 5 data rows
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(6); // header + 5 rows
    expect(lines[0]).toContain("id");
  });

  it("exports a SELECT query to Parquet and reads it back", async () => {
    harness = await createEngine();
    const entry: TableEntry = {
      name: "sales",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
    };
    await harness.engine.registerTable(entry);

    tmp = createTempDir();
    const dest = path.join(tmp.path, "out.parquet");
    await harness.engine.exportQuery(
      "SELECT * FROM sales ORDER BY id",
      dest,
      "parquet",
    );

    expect(fs.existsSync(dest)).toBe(true);
    // Read parquet back through DuckDB to verify it's valid
    const result = await harness.engine.executeQuery(
      `SELECT COUNT(*) AS cnt FROM read_parquet('${dest}')`,
      100,
    );
    expect(Number(result.rows[0].cnt)).toBe(5);
  });

  it("escapes single quotes in destination path", async () => {
    harness = await createEngine();
    const entry: TableEntry = {
      name: "sales",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
    };
    await harness.engine.registerTable(entry);

    tmp = createTempDir();
    const dirWithQuote = path.join(tmp.path, "it's a test");
    fs.mkdirSync(dirWithQuote, { recursive: true });
    const dest = path.join(dirWithQuote, "out.csv");
    await harness.engine.exportQuery("SELECT * FROM sales", dest, "csv");

    expect(fs.existsSync(dest)).toBe(true);
    const content = fs.readFileSync(dest, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(6);
  });

  it("exports full result without maxRows truncation", async () => {
    harness = await createEngine();
    const entry: TableEntry = {
      name: "sales",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
    };
    await harness.engine.registerTable(entry);

    tmp = createTempDir();
    const dest = path.join(tmp.path, "full.csv");
    // exportQuery should NOT apply any row limit
    await harness.engine.exportQuery("SELECT * FROM sales", dest, "csv");

    const content = fs.readFileSync(dest, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(6); // header + all 5 rows, no truncation
  });
});

describe("Engine — raw COPY statement execution", () => {
  let harness: EngineHarness;
  let tmp: TempDir;

  afterEach(() => {
    harness?.dispose();
    tmp?.cleanup();
  });

  it("executes a raw COPY TO CSV and creates the file", async () => {
    harness = await createEngine();
    const entry: TableEntry = {
      name: "sales",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
    };
    await harness.engine.registerTable(entry);

    tmp = createTempDir();
    const dest = path.join(tmp.path, "copy_out.csv");
    const result = await harness.engine.executeQuery(
      `COPY (SELECT * FROM sales ORDER BY id) TO '${dest}' (FORMAT CSV, HEADER)`,
      100,
    );

    // COPY is non-row-producing — should return empty rows with count info
    expect(result.rows.length).toBe(0);
    expect(result.truncated).toBe(false);
    expect(fs.existsSync(dest)).toBe(true);
    const lines = fs.readFileSync(dest, "utf-8").trim().split("\n");
    expect(lines.length).toBe(6);
  });

  it("executes a raw COPY TO Parquet and readback succeeds", async () => {
    harness = await createEngine();
    const entry: TableEntry = {
      name: "sales",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
    };
    await harness.engine.registerTable(entry);

    tmp = createTempDir();
    const dest = path.join(tmp.path, "copy_out.parquet");
    const result = await harness.engine.executeQuery(
      `COPY (SELECT * FROM sales) TO '${dest}' (FORMAT PARQUET)`,
      100,
    );

    expect(result.rows.length).toBe(0);
    expect(result.truncated).toBe(false);
    expect(fs.existsSync(dest)).toBe(true);

    const readback = await harness.engine.executeQuery(
      `SELECT COUNT(*) AS cnt FROM read_parquet('${dest}')`,
      100,
    );
    expect(Number(readback.rows[0].cnt)).toBe(5);
  });

  it("returns an error for malformed COPY statement", async () => {
    harness = await createEngine();
    await expect(
      harness.engine.executeQuery(
        `COPY (SELECT * FROM nonexistent_xyz) TO '/tmp/bad.csv' (FORMAT CSV)`,
        100,
      ),
    ).rejects.toThrow();
  });
});

describe("Engine — CTE and comment queries remain row-producing", () => {
  let harness: EngineHarness;

  afterEach(() => {
    harness?.dispose();
  });

  it("CTE query returns bounded rows with truncation", async () => {
    harness = await createEngine();
    const entry: TableEntry = {
      name: "sales",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
    };
    await harness.engine.registerTable(entry);

    const result = await harness.engine.executeQuery(
      "WITH top_sales AS (SELECT * FROM sales) SELECT * FROM top_sales",
      3,
    );
    expect(result.truncated).toBe(true);
    expect(result.rows.length).toBe(3);
  });

  it("query starting with a comment returns rows", async () => {
    harness = await createEngine();
    const entry: TableEntry = {
      name: "sales",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
    };
    await harness.engine.registerTable(entry);

    const result = await harness.engine.executeQuery(
      "-- fetch all sales\nSELECT * FROM sales",
      100,
    );
    expect(result.rows.length).toBe(5);
    expect(result.truncated).toBe(false);
  });

  it("existing truncation behavior is preserved for plain SELECT", async () => {
    harness = await createEngine();
    const entry: TableEntry = {
      name: "sales",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
    };
    await harness.engine.registerTable(entry);

    const result = await harness.engine.executeQuery(
      "SELECT * FROM sales",
      2,
    );
    expect(result.truncated).toBe(true);
    expect(result.rows.length).toBe(2);
  });
});

describe("Engine — custom COPY with DuckDB options bypasses maxRows", () => {
  let harness: EngineHarness;
  let tmp: TempDir;

  afterEach(() => {
    harness?.dispose();
    tmp?.cleanup();
  });

  it("COPY with DELIMITER, QUOTE, ESCAPE, NULL, HEADER writes all rows beyond maxRows", async () => {
    harness = await createEngine();
    const entry: TableEntry = {
      name: "sales",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
    };
    await harness.engine.registerTable(entry);

    tmp = createTempDir();
    const dest = path.join(tmp.path, "custom_copy.csv");
    // maxRows=2 but COPY should produce ALL 5 rows
    const result = await harness.engine.executeQuery(
      `COPY (SELECT * FROM sales ORDER BY id) TO '${dest}' (FORMAT CSV, HEADER true, DELIMITER '|', QUOTE '"', ESCAPE '\\', NULL 'N/A')`,
      2,
    );

    // COPY is non-row → empty result, not truncated
    expect(result.rows.length).toBe(0);
    expect(result.truncated).toBe(false);

    // Verify ALL rows written despite maxRows=2
    expect(fs.existsSync(dest)).toBe(true);
    const content = fs.readFileSync(dest, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(6); // header + 5 data rows
    // Verify delimiter option was applied
    expect(lines[0]).toContain("|");
    expect(lines[0]).not.toContain(",");
  });
});

describe("Engine — non-row statement not in keyword allowlist", () => {
  let harness: EngineHarness;

  afterEach(() => {
    harness?.dispose();
  });

  it("COMMENT ON executes correctly (not in keyword allowlist)", async () => {
    harness = await createEngine();
    // Create a table so we can comment on it
    await harness.engine.executeQuery("CREATE TABLE comment_test (a INT)", 10);

    // COMMENT ON starts with keyword "COMMENT" — not in the allowlist.
    // The keyword-based approach wraps it in SELECT * FROM (...) which fails.
    // A correct DuckDB-native approach should detect it as ALTER (type 9)
    // and execute it directly.
    const result = await harness.engine.executeQuery(
      "COMMENT ON TABLE comment_test IS 'test table description'",
      10,
    );
    expect(result.rows.length).toBe(0);
    expect(result.truncated).toBe(false);
  });
});

describe("Engine — row-producing statements remain bounded", () => {
  let harness: EngineHarness;

  afterEach(() => {
    harness?.dispose();
  });

  it("VALUES expression is bounded by maxRows", async () => {
    harness = await createEngine();
    const result = await harness.engine.executeQuery(
      "VALUES (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd'), (5, 'e')",
      3,
    );
    expect(result.rows.length).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it("SHOW TABLES returns rows bounded by maxRows", async () => {
    harness = await createEngine();
    const result = await harness.engine.executeQuery("SHOW TABLES", 100);
    // No tables registered → 0 rows, that's fine
    expect(result.truncated).toBe(false);
    expect(result.columns.length).toBeGreaterThan(0);
  });

  it("DESCRIBE returns readable column info", async () => {
    harness = await createEngine();
    const entry: TableEntry = {
      name: "sales",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
    };
    await harness.engine.registerTable(entry);

    const result = await harness.engine.executeQuery(
      "DESCRIBE sales",
      100,
    );
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.columns.length).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
  });

  it("EXPLAIN returns output bounded by maxRows", async () => {
    harness = await createEngine();
    const result = await harness.engine.executeQuery(
      "EXPLAIN SELECT 1 AS x",
      100,
    );
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.columns.length).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
  });

  it("SELECT is truncated at maxRows", async () => {
    harness = await createEngine();
    const entry: TableEntry = {
      name: "sales",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
    };
    await harness.engine.registerTable(entry);

    const result = await harness.engine.executeQuery(
      "SELECT * FROM sales",
      2,
    );
    expect(result.rows.length).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("CTE is truncated at maxRows", async () => {
    harness = await createEngine();
    const entry: TableEntry = {
      name: "sales",
      filePath: path.join(FIXTURES, "sales.csv"),
      fileType: "csv",
      isS3: false,
    };
    await harness.engine.registerTable(entry);

    const result = await harness.engine.executeQuery(
      "WITH s AS (SELECT * FROM sales) SELECT * FROM s",
      2,
    );
    expect(result.rows.length).toBe(2);
    expect(result.truncated).toBe(true);
  });
});

describe("Engine — multi-statement rejection", () => {
  let harness: EngineHarness;

  afterEach(() => {
    harness?.dispose();
  });

  it("rejects multi-statement input with a clear error", async () => {
    harness = await createEngine();
    await expect(
      harness.engine.executeQuery("SELECT 1; DROP TABLE IF EXISTS sales", 10),
    ).rejects.toThrow(/multiple statements/i);
  });

  it("trailing semicolons are not treated as multiple statements", async () => {
    harness = await createEngine();
    // Single statement with trailing semicolons should be fine
    const result = await harness.engine.executeQuery("SELECT 1 AS x;;;", 10);
    expect(result.rows.length).toBe(1);
  });
});
