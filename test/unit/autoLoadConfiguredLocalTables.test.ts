import { describe, it, expect, vi, beforeEach } from "vitest";
import { TableRegistry } from "../../src/tableRegistry";
import { TableEntry } from "../../src/types";

// Mock vscode before importing module under test
vi.mock("vscode", () => import("../helpers/vscode-mock"));

// Mock s3Handler to avoid real AWS calls
vi.mock("../../src/s3Handler", () => ({
    parseS3Uri: vi.fn((uri: string) => {
        const match = uri.match(/^s3:\/\/([^/]+)\/?(.*)$/);
        if (!match) return null;
        return { bucket: match[1], prefix: match[2] ?? "", isFolder: match[2]?.endsWith("/") || match[2] === "" };
    }),
    resolveAwsCredentials: vi.fn().mockResolvedValue({ keyId: "k", secret: "s" }),
    detectBucketRegion: vi.fn().mockResolvedValue("us-east-1"),
    listS3Keys: vi.fn().mockResolvedValue([]),
    downloadS3File: vi.fn().mockResolvedValue(undefined),
    downloadS3Entries: vi.fn().mockResolvedValue([]),
    downloadS3Folder: vi.fn().mockResolvedValue(null),
    downloadS3HiveFolder: vi.fn().mockResolvedValue(null),
    findHivePartitionPrefixes: vi.fn().mockReturnValue([]),
    groupKeysByLeafPrefix: vi.fn().mockReturnValue(new Map()),
    groupS3KeysByFileType: vi.fn().mockReturnValue([]),
    getConfig: vi.fn().mockReturnValue({ profile: "default", region: "us-east-1", maxRows: 1000 }),
    createPerLoadTempDir: vi.fn().mockReturnValue("/tmp/test-perload"),
    cleanupPerLoadTempDir: vi.fn(),
}));

// Mock configManager
vi.mock("../../src/configManager", () => ({
    readConfig: vi.fn().mockResolvedValue({ entries: [], diagnostics: [], missing: false }),
    writeConfig: vi.fn().mockResolvedValue(undefined),
    writeSavedQueries: vi.fn().mockResolvedValue(undefined),
    toConfigEntry: vi.fn((entry: TableEntry, _root: string) => {
        if (entry.isS3 && !entry.source?.startsWith("s3://")) return null;
        return { name: entry.name, source: entry.source ?? entry.filePath, fileType: entry.fileType };
    }),
}));

// Mock fileScanner
vi.mock("../../src/fileScanner", () => ({
    detectFileType: vi.fn().mockReturnValue("csv"),
    deriveTableName: vi.fn((name: string) => name),
}));

// Mock logger
vi.mock("../../src/logger", () => ({
    log: vi.fn(),
    logError: vi.fn(),
    logWarn: vi.fn(),
}));

import { autoLoadConfiguredLocalTables } from "../../src/commands/configCommands";
import * as vscode from "vscode";

// Minimal DuckDBEngine mock
function mockEngine(opts?: { registerDelay?: number; failNames?: string[] }) {
    const { registerDelay = 0, failNames = [] } = opts ?? {};
    const eng = {
        isReady: vi.fn().mockReturnValue(true),
        init: vi.fn().mockResolvedValue(undefined),
        ensureInitialized: vi.fn().mockResolvedValue(undefined),
        registerTable: vi.fn().mockImplementation(async (entry: TableEntry) => {
            if (registerDelay > 0) {
                await new Promise((r) => setTimeout(r, registerDelay));
            }
            if (failNames.includes(entry.name)) {
                throw new Error(`Cannot read file for ${entry.name}`);
            }
            return [{ name: "col1", type: "VARCHAR" }];
        }),
        dropTable: vi.fn().mockResolvedValue(undefined),
    };
    return eng as unknown as import("../../src/duckdbEngine").DuckDBEngine;
}

describe("autoLoadConfiguredLocalTables", () => {
    let registry: TableRegistry;
    let engine: ReturnType<typeof mockEngine>;

    beforeEach(() => {
        registry = new TableRegistry();
        engine = mockEngine();
        vi.clearAllMocks();
    });

    it("loads all local configured entries", async () => {
        registry.addConfigured([
            { name: "sales", source: "./data/sales.csv", fileType: "csv" },
            { name: "events", source: "./logs/events.jsonl", fileType: "json" },
        ]);

        await autoLoadConfiguredLocalTables(registry, engine, "/workspace");

        expect(registry.get("sales")!.loadState).toBe("loaded");
        expect(registry.get("sales")!.columns).toBeDefined();
        expect(registry.get("events")!.loadState).toBe("loaded");
        expect(registry.get("events")!.columns).toBeDefined();
    });

    it("loads local entries in error state (retry)", async () => {
        registry.addConfigured([
            { name: "broken", source: "./data/broken.csv", fileType: "csv" },
        ]);
        registry.setLoadState("broken", "error", "previous failure");

        await autoLoadConfiguredLocalTables(registry, engine, "/workspace");

        expect(registry.get("broken")!.loadState).toBe("loaded");
        expect(registry.get("broken")!.loadError).toBeUndefined();
    });

    it("leaves S3 entries in configured state (lazy)", async () => {
        registry.addConfigured([
            { name: "local_csv", source: "./data/sales.csv", fileType: "csv" },
            { name: "s3_data", source: "s3://my-bucket/data/events.parquet", fileType: "parquet" },
        ]);

        await autoLoadConfiguredLocalTables(registry, engine, "/workspace");

        expect(registry.get("local_csv")!.loadState).toBe("loaded");
        expect(registry.get("s3_data")!.loadState).toBe("configured");
    });

    it("skips entries already in loaded state", async () => {
        registry.addConfigured([
            { name: "already", source: "./data/already.csv", fileType: "csv" },
        ]);
        registry.setLoadState("already", "loaded");

        await autoLoadConfiguredLocalTables(registry, engine, "/workspace");

        // Should not have tried to register it again
        expect(engine.registerTable).not.toHaveBeenCalled();
        expect(registry.get("already")!.loadState).toBe("loaded");
    });

    it("skips entries currently in loading state", async () => {
        registry.addConfigured([
            { name: "inprog", source: "./data/inprog.csv", fileType: "csv" },
        ]);
        registry.setLoadState("inprog", "loading");

        await autoLoadConfiguredLocalTables(registry, engine, "/workspace");

        // Should not attempt to load a table already being loaded
        expect(engine.registerTable).not.toHaveBeenCalled();
    });

    it("stops processing when cancellation is requested", async () => {
        // Use a slow engine to allow cancellation to take effect
        engine = mockEngine({ registerDelay: 50 });

        registry.addConfigured([
            { name: "a", source: "./a.csv", fileType: "csv" },
            { name: "b", source: "./b.csv", fileType: "csv" },
            { name: "c", source: "./c.csv", fileType: "csv" },
            { name: "d", source: "./d.csv", fileType: "csv" },
            { name: "e", source: "./e.csv", fileType: "csv" },
            { name: "f", source: "./f.csv", fileType: "csv" },
        ]);

        // Cancel after a short delay
        const token = {
            isCancellationRequested: false,
            onCancellationRequested: vi.fn(),
        };
        setTimeout(() => {
            token.isCancellationRequested = true;
        }, 30);

        await autoLoadConfiguredLocalTables(
            registry, engine, "/workspace", undefined, token as unknown as vscode.CancellationToken,
        );

        // Not all entries should have been loaded
        const loaded = registry.getAll().filter((e) => e.loadState === "loaded");
        expect(loaded.length).toBeLessThan(6);
    });

    it("one failure does not prevent siblings from loading", async () => {
        engine = mockEngine({ failNames: ["bad"] });

        registry.addConfigured([
            { name: "good1", source: "./good1.csv", fileType: "csv" },
            { name: "bad", source: "./bad.csv", fileType: "csv" },
            { name: "good2", source: "./good2.csv", fileType: "csv" },
        ]);

        await autoLoadConfiguredLocalTables(registry, engine, "/workspace");

        expect(registry.get("good1")!.loadState).toBe("loaded");
        expect(registry.get("bad")!.loadState).toBe("error");
        expect(registry.get("bad")!.loadError).toContain("bad");
        expect(registry.get("good2")!.loadState).toBe("loaded");
    });

    it("concurrency never exceeds the limit (target 4)", async () => {
        // Track concurrent calls
        let concurrent = 0;
        let maxConcurrent = 0;
        const delayEngine = {
            isReady: vi.fn().mockReturnValue(true),
            init: vi.fn().mockResolvedValue(undefined),
            ensureInitialized: vi.fn().mockResolvedValue(undefined),
            registerTable: vi.fn().mockImplementation(async () => {
                concurrent++;
                maxConcurrent = Math.max(maxConcurrent, concurrent);
                await new Promise((r) => setTimeout(r, 20));
                concurrent--;
                return [{ name: "col1", type: "VARCHAR" }];
            }),
            dropTable: vi.fn().mockResolvedValue(undefined),
        } as unknown as import("../../src/duckdbEngine").DuckDBEngine;

        // Add more entries than the concurrency limit
        registry.addConfigured([
            { name: "t1", source: "./t1.csv", fileType: "csv" },
            { name: "t2", source: "./t2.csv", fileType: "csv" },
            { name: "t3", source: "./t3.csv", fileType: "csv" },
            { name: "t4", source: "./t4.csv", fileType: "csv" },
            { name: "t5", source: "./t5.csv", fileType: "csv" },
            { name: "t6", source: "./t6.csv", fileType: "csv" },
            { name: "t7", source: "./t7.csv", fileType: "csv" },
            { name: "t8", source: "./t8.csv", fileType: "csv" },
        ]);

        await autoLoadConfiguredLocalTables(registry, delayEngine, "/workspace");

        // All should be loaded
        for (const name of ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"]) {
            expect(registry.get(name)!.loadState).toBe("loaded");
        }
        // Concurrency must not exceed 4
        expect(maxConcurrent).toBeLessThanOrEqual(4);
        expect(maxConcurrent).toBeGreaterThan(1); // confirm parallelism was used
    });

    it("returns without error when no entries need loading", async () => {
        // Empty registry — nothing to do
        await expect(
            autoLoadConfiguredLocalTables(registry, engine, "/workspace"),
        ).resolves.not.toThrow();
    });

    it("handles mixed: loads local configured/error, skips S3/loaded/loading", async () => {
        registry.addConfigured([
            { name: "local_cfg", source: "./local.csv", fileType: "csv" },
            { name: "local_err", source: "./err.csv", fileType: "csv" },
            { name: "s3_cfg", source: "s3://bucket/data.parquet", fileType: "parquet" },
            { name: "already_loaded", source: "./done.csv", fileType: "csv" },
            { name: "in_progress", source: "./prog.csv", fileType: "csv" },
        ]);
        registry.setLoadState("local_err", "error", "old error");
        registry.setLoadState("already_loaded", "loaded");
        registry.setLoadState("in_progress", "loading");

        await autoLoadConfiguredLocalTables(registry, engine, "/workspace");

        expect(registry.get("local_cfg")!.loadState).toBe("loaded");
        expect(registry.get("local_err")!.loadState).toBe("loaded");
        expect(registry.get("s3_cfg")!.loadState).toBe("configured");
        expect(registry.get("already_loaded")!.loadState).toBe("loaded");
        expect(registry.get("in_progress")!.loadState).toBe("loading");
    });
});
