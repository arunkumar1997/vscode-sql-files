import { describe, it, expect, beforeEach } from "vitest";
import { parseAndValidateConfig, toConfigEntry, ConfigReadError, parseS3Uri, isValidSource, readSavedQueries, writeSavedQueries, sanitizeQueryBaseName } from "../../src/configManager";
import { TableEntry } from "../../src/types";
import { FileType, Uri, workspace } from "../helpers/vscode-mock";

describe("configManager — saved queries", () => {
    beforeEach(() => {
        workspace.fs.writeFile.mockClear();
        workspace.fs.delete.mockClear();
        workspace.fs.readDirectory.mockReset().mockResolvedValue([]);
        workspace.fs.readFile.mockReset().mockRejectedValue(
            Object.assign(new Error("File not found"), { code: "FileNotFound" }),
        );
    });

    it("reads sorted SQL files and ignores other entries", async () => {
        workspace.fs.readDirectory.mockResolvedValueOnce([
            ["second.sql", FileType.File],
            ["notes.txt", FileType.File],
            ["first.sql", FileType.File],
            ["nested", FileType.Directory],
        ] as never);
        workspace.fs.readFile.mockImplementationOnce(async (uri: { fsPath: string }) =>
            Buffer.from(uri.fsPath.endsWith("first.sql") ? "SELECT 1" : "SELECT 2"),
        );
        workspace.fs.readFile.mockImplementationOnce(async (uri: { fsPath: string }) =>
            Buffer.from(uri.fsPath.endsWith("first.sql") ? "SELECT 1" : "SELECT 2"),
        );

        await expect(readSavedQueries(Uri.file("/workspace") as never)).resolves.toEqual([
            { name: "first", sql: "SELECT 1" },
            { name: "second", sql: "SELECT 2" },
        ]);
    });

    it("restores exact query names and order from the managed manifest", async () => {
        workspace.fs.readDirectory.mockResolvedValueOnce([
            ["daily-sales.sql", FileType.File],
            ["totals.sql", FileType.File],
            [".filesql-managed.json", FileType.File],
        ] as never);
        workspace.fs.readFile.mockImplementation(async (uri: { fsPath: string }) => {
            if (uri.fsPath.endsWith(".filesql-managed.json")) {
                return Buffer.from(JSON.stringify({
                    files: ["totals.sql", "daily-sales.sql"],
                    queries: [
                        { name: "Totals / Final", file: "totals.sql" },
                        { name: "Daily: Sales", file: "daily-sales.sql" },
                    ],
                }));
            }
            return Buffer.from(uri.fsPath.endsWith("totals.sql") ? "SELECT 2" : "SELECT 1");
        });

        await expect(readSavedQueries(Uri.file("/workspace") as never)).resolves.toEqual([
            { name: "Totals / Final", sql: "SELECT 2" },
            { name: "Daily: Sales", sql: "SELECT 1" },
        ]);
    });

    it("preserves file order from legacy manifests", async () => {
        workspace.fs.readDirectory.mockResolvedValueOnce([
            ["first.sql", FileType.File],
            ["second.sql", FileType.File],
            [".filesql-managed.json", FileType.File],
        ] as never);
        workspace.fs.readFile.mockImplementation(async (uri: { fsPath: string }) => {
            if (uri.fsPath.endsWith(".filesql-managed.json")) {
                return Buffer.from(JSON.stringify({
                    files: ["second.sql", "first.sql"],
                }));
            }
            return Buffer.from(uri.fsPath.endsWith("first.sql") ? "SELECT 1" : "SELECT 2");
        });

        await expect(readSavedQueries(Uri.file("/workspace") as never)).resolves.toEqual([
            { name: "second", sql: "SELECT 2" },
            { name: "first", sql: "SELECT 1" },
        ]);
    });

    it("writes query tabs as SQL files with sanitized names (via temp+rename)", async () => {
        await writeSavedQueries(Uri.file("/workspace") as never, [
            { name: "daily/sales", sql: "SELECT * FROM sales" },
            { name: "daily/sales", sql: "SELECT COUNT(*) FROM sales" },
        ]);

        // Files are written to temp then renamed to final
        const renameCalls = workspace.fs.rename.mock.calls;
        const finalPaths = renameCalls.map((c: [{ path: string }, { path: string }]) => c[1].path);
        expect(finalPaths.some((p: string) => p.match(/daily-sales\.sql$/))).toBe(true);
        expect(finalPaths.some((p: string) => p.match(/daily-sales \(2\)\.sql$/))).toBe(true);

        // Content goes through writeFile (to temp)
        const writeCalls = workspace.fs.writeFile.mock.calls;
        const contents = writeCalls.map((c: [unknown, Buffer]) => c[1].toString());
        expect(contents).toContain("SELECT * FROM sales");
        expect(contents).toContain("SELECT COUNT(*) FROM sales");
    });

    it("never deletes unmanaged pre-existing SQL files (P0 regression)", async () => {
        // No previous manifest → all existing files treated as unmanaged
        await writeSavedQueries(Uri.file("/workspace") as never, [
            { name: "active", sql: "SELECT 1" },
        ]);

        // No stale managed files to delete (previous manifest was empty)
        const deleteCalls = workspace.fs.delete.mock.calls;
        expect(deleteCalls.length).toBe(0);
    });

    it("preserves non-SQL files in queries directory", async () => {
        await writeSavedQueries(Uri.file("/workspace") as never, [
            { name: "q1", sql: "SELECT 1" },
        ]);

        expect(workspace.fs.delete).not.toHaveBeenCalled();
    });

    it("ignores orphan .staging.*.sql files in readSavedQueries", async () => {
        workspace.fs.readDirectory.mockResolvedValueOnce([
            ["valid.sql", FileType.File],
            [".staging.abcd1234.temp.sql", FileType.File],
            [".staging.deadbeef.report.sql", FileType.File],
            ["other.sql", FileType.File],
        ] as never);
        workspace.fs.readFile.mockImplementation(async (uri: { fsPath: string }) => {
            if (uri.fsPath.endsWith("valid.sql")) return Buffer.from("SELECT 1");
            if (uri.fsPath.endsWith("other.sql")) return Buffer.from("SELECT 2");
            return Buffer.from("ORPHAN");
        });

        const result = await readSavedQueries(Uri.file("/workspace") as never);
        expect(result).toEqual([
            { name: "other", sql: "SELECT 2" },
            { name: "valid", sql: "SELECT 1" },
        ]);
        // Staging files should never have been read
        const readCalls = workspace.fs.readFile.mock.calls;
        const readPaths = readCalls.map((c: [{ fsPath: string }]) => c[0].fsPath);
        expect(readPaths.every((p: string) => !p.includes(".staging."))).toBe(true);
    });
});

describe("configManager — sanitizeQueryBaseName", () => {
    it("replaces invalid filename characters with single hyphen", () => {
        expect(sanitizeQueryBaseName("foo:::bar", 0)).toBe("foo-bar");
        expect(sanitizeQueryBaseName("a/b\\c*d", 0)).toBe("a-b-c-d");
    });

    it("collapses consecutive hyphens from character runs", () => {
        expect(sanitizeQueryBaseName("hello///world", 0)).toBe("hello-world");
        expect(sanitizeQueryBaseName("a<>|b", 0)).toBe("a-b");
    });

    it("strips leading and trailing hyphens", () => {
        expect(sanitizeQueryBaseName("/name/", 0)).toBe("name");
        expect(sanitizeQueryBaseName("***test***", 0)).toBe("test");
    });

    it("caps very long names to 100 characters", () => {
        const longName = "a".repeat(200);
        const result = sanitizeQueryBaseName(longName, 0);
        expect(result.length).toBeLessThanOrEqual(100);
        expect(result).toBe("a".repeat(100));
    });

    it("handles Unicode characters (preserved)", () => {
        expect(sanitizeQueryBaseName("日本語クエリ", 0)).toBe("日本語クエリ");
        expect(sanitizeQueryBaseName("données/café", 0)).toBe("données-café");
    });

    it("falls back to query-N for empty/whitespace names", () => {
        expect(sanitizeQueryBaseName("", 0)).toBe("query-1");
        expect(sanitizeQueryBaseName("   ", 2)).toBe("query-3");
        expect(sanitizeQueryBaseName("///", 4)).toBe("query-5");
    });

    it("strips .sql suffix before sanitization", () => {
        expect(sanitizeQueryBaseName("report.sql", 0)).toBe("report");
        expect(sanitizeQueryBaseName("report.SQL", 0)).toBe("report");
    });

    it("handles duplicate name suffixes deterministically", () => {
        // Suffixes are handled by writeSavedQueries, not the sanitizer
        // but the base name must be stable
        const a = sanitizeQueryBaseName("my query", 0);
        const b = sanitizeQueryBaseName("my query", 1);
        expect(a).toBe(b);
    });

    it("prefixes Windows reserved device names", () => {
        expect(sanitizeQueryBaseName("CON", 0)).toBe("_CON");
        expect(sanitizeQueryBaseName("con", 0)).toBe("_con");
        expect(sanitizeQueryBaseName("PRN", 0)).toBe("_PRN");
        expect(sanitizeQueryBaseName("AUX", 0)).toBe("_AUX");
        expect(sanitizeQueryBaseName("NUL", 0)).toBe("_NUL");
        expect(sanitizeQueryBaseName("COM1", 0)).toBe("_COM1");
        expect(sanitizeQueryBaseName("COM9", 0)).toBe("_COM9");
        expect(sanitizeQueryBaseName("LPT1", 0)).toBe("_LPT1");
        expect(sanitizeQueryBaseName("LPT9", 0)).toBe("_LPT9");
        // With .sql extension stripped first
        expect(sanitizeQueryBaseName("CON.sql", 0)).toBe("_CON");
        expect(sanitizeQueryBaseName("nul.SQL", 0)).toBe("_nul");
        // With spaces (trimmed to bare name)
        expect(sanitizeQueryBaseName("  AUX  ", 0)).toBe("_AUX");
    });

    it("does not prefix names that only contain a reserved name as substring", () => {
        expect(sanitizeQueryBaseName("CONQUER", 0)).toBe("CONQUER");
        expect(sanitizeQueryBaseName("PRNT", 0)).toBe("PRNT");
        expect(sanitizeQueryBaseName("NULLIFY", 0)).toBe("NULLIFY");
        expect(sanitizeQueryBaseName("COM10", 0)).toBe("COM10");
    });
});

describe("configManager — parseAndValidateConfig", () => {
    it("returns empty entries for missing/empty content", () => {
        const result = parseAndValidateConfig("");
        expect(result.entries).toEqual([]);
        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(result.diagnostics[0].message).toMatch(/Invalid JSON/);
    });

    it("returns empty entries for non-object JSON", () => {
        const result = parseAndValidateConfig('"hello"');
        expect(result.entries).toEqual([]);
        expect(result.diagnostics[0].message).toMatch(/must be a JSON object/);
    });

    it("rejects unsupported version", () => {
        const result = parseAndValidateConfig(JSON.stringify({ version: 99, tables: [] }));
        expect(result.entries).toEqual([]);
        expect(result.diagnostics[0].message).toMatch(/Unsupported config version/);
    });

    it("rejects missing tables array", () => {
        const result = parseAndValidateConfig(JSON.stringify({ version: 1 }));
        expect(result.entries).toEqual([]);
        expect(result.diagnostics[0].message).toMatch(/'tables' must be an array/);
    });

    it("parses a valid config with local paths", () => {
        const config = {
            version: 1,
            tables: [
                { name: "sales", source: "./data/sales.csv", fileType: "csv" },
                { name: "events", source: "./logs/events.jsonl", fileType: "json" },
            ],
        };
        const result = parseAndValidateConfig(JSON.stringify(config));
        expect(result.diagnostics).toEqual([]);
        expect(result.entries).toHaveLength(2);
        expect(result.entries[0]).toEqual({ name: "sales", source: "./data/sales.csv", fileType: "csv" });
        expect(result.entries[1]).toEqual({ name: "events", source: "./logs/events.jsonl", fileType: "json" });
    });

    it("parses a valid config with S3 URI and hivePartitioning", () => {
        const config = {
            version: 1,
            tables: [
                { name: "logs", source: "s3://bucket/path/", fileType: "parquet", hivePartitioning: true },
            ],
        };
        const result = parseAndValidateConfig(JSON.stringify(config));
        expect(result.diagnostics).toEqual([]);
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]).toEqual({
            name: "logs",
            source: "s3://bucket/path/",
            fileType: "parquet",
            hivePartitioning: true,
        });
    });

    it("preserves S3 trailing-slash semantics", () => {
        const withSlash = {
            version: 1,
            tables: [{ name: "a", source: "s3://bucket/path/", fileType: "parquet" }],
        };
        const withoutSlash = {
            version: 1,
            tables: [{ name: "b", source: "s3://bucket/path", fileType: "parquet" }],
        };
        expect(parseAndValidateConfig(JSON.stringify(withSlash)).entries[0].source).toBe("s3://bucket/path/");
        expect(parseAndValidateConfig(JSON.stringify(withoutSlash)).entries[0].source).toBe("s3://bucket/path");
    });

    it("omits hivePartitioning when false/undefined", () => {
        const config = {
            version: 1,
            tables: [
                { name: "t", source: "./t.csv", fileType: "csv", hivePartitioning: false },
            ],
        };
        const result = parseAndValidateConfig(JSON.stringify(config));
        expect(result.entries[0]).toEqual({ name: "t", source: "./t.csv", fileType: "csv" });
        expect("hivePartitioning" in result.entries[0]).toBe(false);
    });

    it("rejects entries with invalid name", () => {
        const config = {
            version: 1,
            tables: [{ name: "", source: "./x.csv", fileType: "csv" }],
        };
        const result = parseAndValidateConfig(JSON.stringify(config));
        expect(result.entries).toHaveLength(0);
        expect(result.diagnostics.some((d) => d.message.match(/name.*non-empty/))).toBe(true);
    });

    it("rejects entries with absolute local path", () => {
        const config = {
            version: 1,
            tables: [{ name: "t", source: "/absolute/path.csv", fileType: "csv" }],
        };
        const result = parseAndValidateConfig(JSON.stringify(config));
        expect(result.entries).toHaveLength(0);
        expect(result.diagnostics.some((d) => d.message.match(/workspace-relative/))).toBe(true);
    });

    it("rejects entries with invalid fileType", () => {
        const config = {
            version: 1,
            tables: [{ name: "t", source: "./x.bin", fileType: "binary" }],
        };
        const result = parseAndValidateConfig(JSON.stringify(config));
        expect(result.entries).toHaveLength(0);
        expect(result.diagnostics.some((d) => d.message.match(/fileType/))).toBe(true);
    });

    it("rejects entries with non-boolean hivePartitioning", () => {
        const config = {
            version: 1,
            tables: [{ name: "t", source: "./x.csv", fileType: "csv", hivePartitioning: "yes" }],
        };
        const result = parseAndValidateConfig(JSON.stringify(config));
        expect(result.entries).toHaveLength(0);
        expect(result.diagnostics.some((d) => d.message.match(/hivePartitioning.*boolean/))).toBe(true);
    });

    // CORRECTION 3: Fails entire config on ANY invalid row
    it("fails entire config if any row is invalid (no partial acceptance)", () => {
        const config = {
            version: 1,
            tables: [
                { name: "", source: "./bad.csv", fileType: "csv" },
                { name: "good", source: "./good.csv", fileType: "csv" },
                { name: "bad2", source: "/absolute.csv", fileType: "csv" },
            ],
        };
        const result = parseAndValidateConfig(JSON.stringify(config));
        expect(result.entries).toHaveLength(0);
        expect(result.diagnostics.length).toBeGreaterThanOrEqual(2);
    });

    // CORRECTION 3: Duplicates fail entire config
    it("fails entire config on duplicate names", () => {
        const config = {
            version: 1,
            tables: [
                { name: "dup", source: "./a.csv", fileType: "csv" },
                { name: "dup", source: "./b.csv", fileType: "csv" },
            ],
        };
        const result = parseAndValidateConfig(JSON.stringify(config));
        expect(result.entries).toHaveLength(0);
        expect(result.diagnostics.some((d) => d.message.match(/duplicate name/))).toBe(true);
    });

    it("handles malformed JSON gracefully", () => {
        const result = parseAndValidateConfig("{ not valid json");
        expect(result.entries).toEqual([]);
        expect(result.diagnostics[0].message).toMatch(/Invalid JSON/);
    });

    it("handles an empty tables array", () => {
        const result = parseAndValidateConfig(JSON.stringify({ version: 1, tables: [] }));
        expect(result.entries).toEqual([]);
        expect(result.diagnostics).toEqual([]);
    });

    it("rejects an s3:// URI with no path after scheme", () => {
        const config = {
            version: 1,
            tables: [{ name: "t", source: "s3://", fileType: "csv" }],
        };
        const result = parseAndValidateConfig(JSON.stringify(config));
        expect(result.entries).toHaveLength(0);
    });

    it("rejects s3:// URI with whitespace-only bucket", () => {
        const config = {
            version: 1,
            tables: [{ name: "t", source: "s3://   /key", fileType: "csv" }],
        };
        const result = parseAndValidateConfig(JSON.stringify(config));
        expect(result.entries).toHaveLength(0);
    });

    it("rejects s3:// URI with userinfo/credentials", () => {
        const config = {
            version: 1,
            tables: [{ name: "t", source: "s3://user:pass@bucket/key", fileType: "csv" }],
        };
        const result = parseAndValidateConfig(JSON.stringify(config));
        expect(result.entries).toHaveLength(0);
    });

    it("rejects s3:// URI with query string", () => {
        const config = {
            version: 1,
            tables: [{ name: "t", source: "s3://bucket/key?versionId=123", fileType: "csv" }],
        };
        const result = parseAndValidateConfig(JSON.stringify(config));
        expect(result.entries).toHaveLength(0);
    });

    it("rejects s3:// URI with fragment", () => {
        const config = {
            version: 1,
            tables: [{ name: "t", source: "s3://bucket/key#section", fileType: "csv" }],
        };
        const result = parseAndValidateConfig(JSON.stringify(config));
        expect(result.entries).toHaveLength(0);
    });

    // CORRECTION 3: Reject unknown properties
    it("rejects entries with unknown properties", () => {
        const config = {
            version: 1,
            tables: [{ name: "t", source: "./x.csv", fileType: "csv", unknownProp: 42 }],
        };
        const result = parseAndValidateConfig(JSON.stringify(config));
        expect(result.entries).toHaveLength(0);
        expect(result.diagnostics.some((d) => d.message.match(/unknown property/))).toBe(true);
    });

    // CORRECTION 3: Reject credential properties
    it("rejects entries with credential/runtime properties", () => {
        const config = {
            version: 1,
            tables: [{ name: "t", source: "./x.csv", fileType: "csv", accessKeyId: "AKIA..." }],
        };
        const result = parseAndValidateConfig(JSON.stringify(config));
        expect(result.entries).toHaveLength(0);
        expect(result.diagnostics.some((d) => d.message.match(/forbidden property/))).toBe(true);
    });

    it("rejects entries with runtime state properties", () => {
        const config = {
            version: 1,
            tables: [{ name: "t", source: "./x.csv", fileType: "csv", loadState: "loaded", filePath: "/tmp/x" }],
        };
        const result = parseAndValidateConfig(JSON.stringify(config));
        expect(result.entries).toHaveLength(0);
        expect(result.diagnostics.some((d) => d.message.match(/forbidden property/))).toBe(true);
    });

    // CORRECTION 3: Reject unknown top-level properties
    it("rejects unknown top-level properties", () => {
        const config = { version: 1, tables: [], "$schema": "http://example.com/schema.json" };
        const result = parseAndValidateConfig(JSON.stringify(config));
        expect(result.entries).toEqual([]);
        expect(result.diagnostics.some((d) => d.message.match(/Unknown top-level property/))).toBe(true);
    });

    // CORRECTION 4: Cross-platform path rejection
    it("rejects UNC paths (\\\\server\\share)", () => {
        const config = {
            version: 1,
            tables: [{ name: "t", source: "\\\\server\\share\\file.csv", fileType: "csv" }],
        };
        const result = parseAndValidateConfig(JSON.stringify(config));
        expect(result.entries).toHaveLength(0);
    });

    it("rejects UNC paths (//server/share)", () => {
        const config = {
            version: 1,
            tables: [{ name: "t", source: "//server/share/file.csv", fileType: "csv" }],
        };
        const result = parseAndValidateConfig(JSON.stringify(config));
        expect(result.entries).toHaveLength(0);
    });

    it("rejects Windows device paths (C:path)", () => {
        const config = {
            version: 1,
            tables: [{ name: "t", source: "C:data/file.csv", fileType: "csv" }],
        };
        const result = parseAndValidateConfig(JSON.stringify(config));
        expect(result.entries).toHaveLength(0);
    });

    it("rejects workspace traversal (../)", () => {
        const config = {
            version: 1,
            tables: [{ name: "t", source: "../outside/file.csv", fileType: "csv" }],
        };
        const result = parseAndValidateConfig(JSON.stringify(config));
        expect(result.entries).toHaveLength(0);
    });

    it("rejects embedded traversal (./data/../../../etc/passwd)", () => {
        const config = {
            version: 1,
            tables: [{ name: "t", source: "./data/../../../etc/passwd", fileType: "csv" }],
        };
        const result = parseAndValidateConfig(JSON.stringify(config));
        expect(result.entries).toHaveLength(0);
    });

    it("rejects backslashes in local paths", () => {
        const config = {
            version: 1,
            tables: [{ name: "t", source: ".\\data\\file.csv", fileType: "csv" }],
        };
        const result = parseAndValidateConfig(JSON.stringify(config));
        expect(result.entries).toHaveLength(0);
    });
});

describe("configManager — toConfigEntry", () => {
    it("converts a local table entry using preserved source field", () => {
        const entry: TableEntry = {
            name: "sales",
            filePath: "/workspace/data/sales.csv",
            fileType: "csv",
            isS3: false,
            source: "./data/sales.csv",
            columns: [{ name: "id", type: "INTEGER" }],
            loadState: "loaded",
            origin: "config",
        };
        const result = toConfigEntry(entry, "/workspace");
        expect(result).toEqual({ name: "sales", source: "./data/sales.csv", fileType: "csv" });
    });

    it("derives relative path when source is not preserved (adhoc local)", () => {
        const entry: TableEntry = {
            name: "sales",
            filePath: "/workspace/data/sales.csv",
            fileType: "csv",
            isS3: false,
            loadState: "loaded",
            origin: "adhoc",
        };
        const result = toConfigEntry(entry, "/workspace");
        expect(result).toEqual({ name: "sales", source: "./data/sales.csv", fileType: "csv" });
    });

    it("uses source for S3 entries", () => {
        const entry: TableEntry = {
            name: "events",
            filePath: "/tmp/file-sql-xxx/events.parquet",
            fileType: "parquet",
            isS3: true,
            source: "s3://bucket/events/",
            sourceUri: "s3://bucket/events/",
            hivePartitioning: true,
            loadState: "loaded",
            origin: "config",
        };
        const result = toConfigEntry(entry, "/workspace");
        expect(result).toEqual({
            name: "events",
            source: "s3://bucket/events/",
            fileType: "parquet",
            hivePartitioning: true,
        });
    });

    it("falls back to sourceUri when source is missing for S3", () => {
        const entry: TableEntry = {
            name: "t",
            filePath: "/tmp/download.csv",
            fileType: "csv",
            isS3: true,
            sourceUri: "s3://fallback/path.csv",
            origin: "adhoc",
        };
        const result = toConfigEntry(entry, "/workspace");
        expect(result).not.toBeNull();
        expect(result!.source).toBe("s3://fallback/path.csv");
    });

    // CORRECTION 2: Reject S3 entries with no valid source
    it("returns null for S3 entry missing both source and sourceUri", () => {
        const entry: TableEntry = {
            name: "t",
            filePath: "/tmp/file-sql-xxx/download.parquet",
            fileType: "parquet",
            isS3: true,
            origin: "adhoc",
        };
        const result = toConfigEntry(entry, "/workspace");
        expect(result).toBeNull();
    });

    it("strips runtime fields (columns, loadState, loadError, origin)", () => {
        const entry: TableEntry = {
            name: "t",
            filePath: "/workspace/t.json",
            fileType: "json",
            isS3: false,
            source: "./t.json",
            columns: [{ name: "x", type: "TEXT" }],
            loadState: "loaded",
            loadError: undefined,
            origin: "config",
        };
        const result = toConfigEntry(entry, "/workspace");
        expect(result).toEqual({ name: "t", source: "./t.json", fileType: "json" });
        expect("columns" in result!).toBe(false);
        expect("loadState" in result!).toBe(false);
        expect("loadError" in result!).toBe(false);
        expect("isS3" in result!).toBe(false);
        expect("origin" in result!).toBe(false);
    });

    it("normalizes backslashes to forward slashes", () => {
        const entry: TableEntry = {
            name: "t",
            filePath: "C:\\workspace\\data\\file.csv",
            fileType: "csv",
            isS3: false,
            source: ".\\data\\file.csv",
            origin: "adhoc",
        };
        const result = toConfigEntry(entry, "C:\\workspace");
        expect(result!.source).toBe("./data/file.csv");
    });

    it("preserves S3 trailing slash in toConfigEntry", () => {
        const entry: TableEntry = {
            name: "t",
            filePath: "/tmp/x",
            fileType: "parquet",
            isS3: true,
            source: "s3://bucket/prefix/",
            sourceUri: "s3://bucket/prefix/",
            origin: "config",
        };
        const result = toConfigEntry(entry, "/workspace");
        expect(result!.source).toBe("s3://bucket/prefix/");
    });
});

// CORRECTION 7: ConfigReadError type tests
describe("configManager — ConfigReadError", () => {
    it("has correct properties for NOT_FOUND", () => {
        const uri = Uri.file("/ws/.filesql/config.json");
        const err = new ConfigReadError("File not found", "NOT_FOUND", uri as unknown as import("vscode").Uri);
        expect(err.code).toBe("NOT_FOUND");
        expect(err.name).toBe("ConfigReadError");
        expect(err.uri).toBe(uri);
    });

    it("has correct properties for READ_FAILURE", () => {
        const uri = Uri.file("/ws/.filesql/config.json");
        const cause = new Error("permission denied");
        const err = new ConfigReadError("Failed to read", "READ_FAILURE", uri as unknown as import("vscode").Uri, cause);
        expect(err.code).toBe("READ_FAILURE");
        expect(err.cause).toBe(cause);
    });
});

describe("configManager — parseS3Uri (strict S3 parsing)", () => {
    it("parses a valid s3://bucket/key", () => {
        const result = parseS3Uri("s3://my-bucket/path/to/file.parquet");
        expect(result).toEqual({ bucket: "my-bucket", key: "path/to/file.parquet" });
    });

    it("parses s3://bucket (no key)", () => {
        const result = parseS3Uri("s3://my-bucket");
        expect(result).toEqual({ bucket: "my-bucket", key: "" });
    });

    it("preserves trailing slash in key", () => {
        const result = parseS3Uri("s3://bucket/prefix/");
        expect(result).toEqual({ bucket: "bucket", key: "prefix/" });
    });

    it("rejects non-s3 scheme", () => {
        expect(parseS3Uri("http://bucket/key")).toBeNull();
        expect(parseS3Uri("gs://bucket/key")).toBeNull();
    });

    it("rejects empty after s3://", () => {
        expect(parseS3Uri("s3://")).toBeNull();
    });

    it("rejects whitespace-only bucket", () => {
        expect(parseS3Uri("s3://   /key")).toBeNull();
    });

    it("rejects bucket with whitespace", () => {
        expect(parseS3Uri("s3://my bucket/key")).toBeNull();
        expect(parseS3Uri("s3://my\tbucket/key")).toBeNull();
    });

    it("rejects userinfo/credential forms (user@bucket)", () => {
        expect(parseS3Uri("s3://user@bucket/key")).toBeNull();
        expect(parseS3Uri("s3://user:pass@bucket/key")).toBeNull();
    });

    it("rejects query strings", () => {
        expect(parseS3Uri("s3://bucket/key?versionId=123")).toBeNull();
    });

    it("rejects fragments", () => {
        expect(parseS3Uri("s3://bucket/key#section")).toBeNull();
    });

    it("accepts valid bucket names with dots and hyphens", () => {
        const result = parseS3Uri("s3://my-data.bucket.v2/key");
        expect(result).toEqual({ bucket: "my-data.bucket.v2", key: "key" });
    });
});

describe("configManager — isValidSource (S3 strict validation)", () => {
    it("rejects s3:// with whitespace-only bucket", () => {
        expect(isValidSource("s3://   /key")).toBe(false);
    });

    it("rejects s3:// with userinfo", () => {
        expect(isValidSource("s3://user:pass@bucket/key")).toBe(false);
    });

    it("rejects s3:// with query", () => {
        expect(isValidSource("s3://bucket/key?versionId=1")).toBe(false);
    });

    it("rejects s3:// with fragment", () => {
        expect(isValidSource("s3://bucket/key#frag")).toBe(false);
    });

    it("accepts valid s3:// with trailing slash", () => {
        expect(isValidSource("s3://bucket/prefix/")).toBe(true);
    });

    it("accepts valid s3:// without trailing slash", () => {
        expect(isValidSource("s3://bucket/file.parquet")).toBe(true);
    });
});

describe("configManager — toConfigEntry (rejection cases)", () => {
    it("returns null for local entry outside workspace (no basename fallback)", () => {
        const entry: TableEntry = {
            name: "outside",
            filePath: "/other/project/data.csv",
            fileType: "csv",
            isS3: false,
            origin: "adhoc",
        };
        const result = toConfigEntry(entry, "/workspace");
        expect(result).toBeNull();
    });

    it("returns null for S3 entry with malformed source (userinfo)", () => {
        const entry: TableEntry = {
            name: "t",
            filePath: "/tmp/download.csv",
            fileType: "csv",
            isS3: true,
            source: "s3://user:pass@bucket/key",
            sourceUri: "s3://user:pass@bucket/key",
            origin: "adhoc",
        };
        const result = toConfigEntry(entry, "/workspace");
        expect(result).toBeNull();
    });

    it("returns null for S3 entry with query string in source", () => {
        const entry: TableEntry = {
            name: "t",
            filePath: "/tmp/download.csv",
            fileType: "csv",
            isS3: true,
            source: "s3://bucket/key?versionId=1",
            origin: "adhoc",
        };
        const result = toConfigEntry(entry, "/workspace");
        expect(result).toBeNull();
    });
});

// --- Regression: whitespace normalization BEFORE safety checks ---
describe("configManager — normalize-before-validate regressions", () => {
    it("rejects leading-whitespace absolute path (would bypass startsWith check)", () => {
        const config = {
            version: 1,
            tables: [{ name: "t", source: "  /etc/passwd", fileType: "csv" }],
        };
        const result = parseAndValidateConfig(JSON.stringify(config));
        expect(result.entries).toHaveLength(0);
        expect(result.diagnostics.some((d) => d.message.match(/workspace-relative/))).toBe(true);
    });

    it("rejects trailing-whitespace traversal (would bypass segment check)", () => {
        const config = {
            version: 1,
            tables: [{ name: "t", source: " ../../../etc/passwd", fileType: "csv" }],
        };
        const result = parseAndValidateConfig(JSON.stringify(config));
        expect(result.entries).toHaveLength(0);
    });

    it("rejects whitespace-padded s3 credential URI (would bypass s3:// detection)", () => {
        const config = {
            version: 1,
            tables: [{ name: "t", source: "  s3://user:pass@bucket/key", fileType: "csv" }],
        };
        const result = parseAndValidateConfig(JSON.stringify(config));
        expect(result.entries).toHaveLength(0);
    });

    it("rejects whitespace-padded s3 query string URI", () => {
        const config = {
            version: 1,
            tables: [{ name: "t", source: " s3://bucket/key?token=SECRET", fileType: "csv" }],
        };
        const result = parseAndValidateConfig(JSON.stringify(config));
        expect(result.entries).toHaveLength(0);
    });

    it("detects duplicate names after trimming (would bypass raw dedup)", () => {
        const config = {
            version: 1,
            tables: [
                { name: "sales", source: "./a.csv", fileType: "csv" },
                { name: " sales ", source: "./b.csv", fileType: "csv" },
            ],
        };
        const result = parseAndValidateConfig(JSON.stringify(config));
        expect(result.entries).toHaveLength(0);
        expect(result.diagnostics.some((d) => d.message.match(/duplicate name/))).toBe(true);
    });

    it("writeConfig rejects whitespace-padded absolute path", async () => {
        const root = Uri.file("/workspace") as unknown as import("vscode").Uri;
        const entries = [{ name: "t", source: "  /etc/shadow", fileType: "csv" as const }];
        await expect(
            (await import("../../src/configManager")).writeConfig(root, entries),
        ).rejects.toThrow(/validation failed/);
    });

    it("writeConfig detects duplicates after trimming", async () => {
        const root = Uri.file("/workspace") as unknown as import("vscode").Uri;
        const entries = [
            { name: "x", source: "./a.csv", fileType: "csv" as const },
            { name: " x ", source: "./b.csv", fileType: "csv" as const },
        ];
        await expect(
            (await import("../../src/configManager")).writeConfig(root, entries),
        ).rejects.toThrow(/validation failed/);
    });

    it("writeConfig rejects whitespace-padded traversal source", async () => {
        const root = Uri.file("/workspace") as unknown as import("vscode").Uri;
        const entries = [{ name: "t", source: " ../../etc/passwd", fileType: "csv" as const }];
        await expect(
            (await import("../../src/configManager")).writeConfig(root, entries),
        ).rejects.toThrow(/validation failed/);
    });
});
