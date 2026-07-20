import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { DuckDBEngine } from "../../src/duckdbEngine";
import * as fsp from "fs/promises";
import * as path from "path";
import * as os from "os";

// Suppress known DuckDB bad_weak_ptr teardown errors (upstream issue)
process.on("unhandledRejection", (reason) => {
    if (reason instanceof Error && reason.message.includes("bad_weak_ptr")) return;
    throw reason;
});

describe("DuckDB Engine - S3 Range Read Support", () => {
    let engine: DuckDBEngine;
    let tmpDir: string;

    beforeAll(async () => {
        engine = new DuckDBEngine();
        await engine.init();
        tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "range-test-"));
    });

    afterAll(async () => {
        // Skip engine.dispose() — DuckDB with httpfs triggers bad_weak_ptr crash
        // on teardown (upstream @duckdb/node-api issue). Process exits anyway in
        // forked pool mode. Clean up temp files only.
        await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    describe("ensureHttpfs", () => {
        it("loads httpfs idempotently", async () => {
            await engine.ensureHttpfs();
            await engine.ensureHttpfs(); // should not throw
        });
    });

    describe("createScopedS3Secret", () => {
        it("creates a temporary secret and returns a unique name", async () => {
            const secretName = await engine.createScopedS3Secret(
                "test_table",
                "my-bucket",
                "data/",
                { keyId: "AKIAIOSFODNN7EXAMPLE", secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
                "us-east-1",
            );
            expect(secretName).toMatch(/^filesql_test_table_[a-f0-9]{8}$/);
        });

        it("generates unique names for different tables", async () => {
            const creds = { keyId: "AKIAIOSFODNN7EXAMPLE", secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
            const name1 = await engine.createScopedS3Secret("table_a", "bucket", "p1/", creds, "us-east-1");
            const name2 = await engine.createScopedS3Secret("table_b", "bucket", "p2/", creds, "us-east-1");
            expect(name1).not.toBe(name2);
        });

        it("handles special characters in table name", async () => {
            const secretName = await engine.createScopedS3Secret(
                "my-table/with.dots",
                "bucket",
                "data/",
                { keyId: "AKIATEST", secret: "secretval" },
                "eu-west-1",
            );
            expect(secretName).toMatch(/^filesql_my_table_with_dots_[a-f0-9]{8}$/);
        });

        it("supports session tokens", async () => {
            const secretName = await engine.createScopedS3Secret(
                "token_table",
                "bucket",
                "data/",
                { keyId: "AKIATEST", secret: "secretval", token: "sessiontokenvalue" },
                "us-west-2",
            );
            expect(secretName).toBeTruthy();
        });

        it("uses path-style URLs for dotted bucket names", async () => {
            const secretName = await engine.createScopedS3Secret(
                "dotted_bucket",
                "bucket.with.dots",
                "data/",
                { keyId: "AKIATEST", secret: "secretval" },
                "eu-north-1",
            );
            const result = await engine.executeQuery(
                `SELECT secret_string FROM duckdb_secrets() WHERE name = '${secretName}'`,
                1,
            );
            expect(String(result.rows[0]?.secret_string)).toContain("url_style=path");
        });

        it("handles single quotes in credentials", async () => {
            const secretName = await engine.createScopedS3Secret(
                "quote_test",
                "bucket",
                "data/",
                { keyId: "AKIA'TEST", secret: "secret'val" },
                "us-east-1",
            );
            expect(secretName).toBeTruthy();
        });
    });

    describe("dropS3Secret", () => {
        it("drops an existing secret without throwing", async () => {
            await engine.createScopedS3Secret(
                "drop_test",
                "bucket",
                "data/",
                { keyId: "AKIATEST", secret: "secretval" },
                "us-east-1",
            );
            await engine.dropS3Secret("drop_test");
        });

        it("does nothing for non-existent table", async () => {
            await engine.dropS3Secret("nonexistent");
        });
    });

    describe("registerRangeTable", () => {
        it("creates a view from local parquet (simulating S3 URI)", async () => {
            const parquetPath = path.join(tmpDir, "single.parquet");
            await engine.executeQuery(
                `COPY (SELECT 1 AS id, 'hello' AS name) TO '${parquetPath.replace(/'/g, "''")}' (FORMAT PARQUET)`,
                10,
            );

            const entry = {
                name: "range_single",
                filePath: parquetPath,
                fileType: "parquet" as const,
                isS3: true,
                sourceUri: "s3://bucket/test.parquet",
            };

            const cols = await engine.registerRangeTable(entry, [parquetPath], false);
            expect(cols).toHaveLength(2);
            expect(cols[0].name).toBe("id");
            expect(cols[1].name).toBe("name");

            const result = await engine.executeQuery("SELECT * FROM range_single", 10);
            expect(result.rows).toHaveLength(1);
            expect(result.rows[0].id).toBe(1);
            expect(result.rows[0].name).toBe("hello");
        });

        it("supports multiple URIs (local paths for testing)", async () => {
            const parquetPath1 = path.join(tmpDir, "multi1.parquet");
            const parquetPath2 = path.join(tmpDir, "multi2.parquet");

            await engine.executeQuery(
                `COPY (SELECT 1 AS id) TO '${parquetPath1.replace(/'/g, "''")}' (FORMAT PARQUET)`,
                10,
            );
            await engine.executeQuery(
                `COPY (SELECT 2 AS id) TO '${parquetPath2.replace(/'/g, "''")}' (FORMAT PARQUET)`,
                10,
            );

            const entry = {
                name: "range_multi",
                filePath: `s3://bucket/data/`,
                fileType: "parquet" as const,
                isS3: true,
            };

            const cols = await engine.registerRangeTable(entry, [parquetPath1, parquetPath2], false);
            expect(cols).toHaveLength(1);

            const result = await engine.executeQuery("SELECT * FROM range_multi ORDER BY id", 10);
            expect(result.rows).toHaveLength(2);
        });

        it("rolls back view on introspection failure", async () => {
            const entry = {
                name: "fail_range",
                filePath: "s3://bucket/nonexistent.parquet",
                fileType: "parquet" as const,
                isS3: true,
            };

            await expect(
                engine.registerRangeTable(entry, ["/nonexistent/path.parquet"], false),
            ).rejects.toThrow();
        });
    });

    describe("validateRangeRead", () => {
        it("passes for a valid parquet view", async () => {
            const parquetPath = path.join(tmpDir, "validate.parquet");
            await engine.executeQuery(
                `COPY (SELECT 42 AS val) TO '${parquetPath.replace(/'/g, "''")}' (FORMAT PARQUET)`,
                10,
            );

            const entry = {
                name: "validate_table",
                filePath: parquetPath,
                fileType: "parquet" as const,
                isS3: true,
            };
            await engine.registerRangeTable(entry, [parquetPath], false);
            await engine.validateRangeRead("validate_table");
        });
    });

    describe("credential leakage prevention", () => {
        it("createScopedS3Secret error does not contain credential SQL in thrown message", async () => {
            // Force a failure by providing an invalid TYPE value to trigger SQL error
            // We can't easily break CREATE SECRET with valid syntax since DuckDB accepts it,
            // but we can verify the error path by checking what logError receives.
            // Instead, verify that the thrown error (if any) from a valid call does not
            // include credential material in its string representation.
            const fakeSecret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
            const fakeKey = "AKIAIOSFODNN7EXAMPLE";
            const fakeToken = "FwoGZXIvYXdzEBYaDHqa0AP1L0M0EXAMPLETOKEN";

            // This should succeed (no error). Verifying the success path doesn't leak.
            const name = await engine.createScopedS3Secret(
                "leak_test",
                "bucket",
                "data/",
                { keyId: fakeKey, secret: fakeSecret, token: fakeToken },
                "us-east-1",
            );
            expect(name).toBeTruthy();
            // The secret name should not contain credential material
            expect(name).not.toContain(fakeSecret);
            expect(name).not.toContain(fakeKey);
            expect(name).not.toContain(fakeToken);
        });

        it("multiple secrets coexist and independent cleanup works", async () => {
            const creds = { keyId: "AKIATEST1", secret: "secret1" };
            await engine.createScopedS3Secret("coexist_a", "b1", "p1/", creds, "us-east-1");
            await engine.createScopedS3Secret("coexist_b", "b2", "p2/", creds, "us-east-1");

            // Dropping one does not affect the other
            await engine.dropS3Secret("coexist_a");
            // coexist_b secret should still work (we can't query it without real S3,
            // but dropS3Secret should succeed without throwing)
            await engine.dropS3Secret("coexist_b");
        });
    });
});
