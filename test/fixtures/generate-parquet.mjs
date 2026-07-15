import { DuckDBInstance } from "@duckdb/node-api";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dirname, "metrics.parquet");

const instance = await DuckDBInstance.create(":memory:");
const conn = await instance.connect();

await conn.run(`
  CREATE TABLE metrics AS SELECT * FROM (VALUES
    (1, 'cpu', 72.5, '2024-01-15'),
    (2, 'memory', 85.3, '2024-02-20'),
    (3, 'disk', 45.1, '2024-03-10'),
    (4, 'cpu', 91.0, '2024-04-05'),
    (5, 'network', 30.8, '2024-05-12')
  ) AS t(id, metric, value, ts)
`);

await conn.run(`COPY metrics TO '${outPath}' (FORMAT PARQUET)`);
conn.closeSync();
console.log(`Generated ${outPath}`);
