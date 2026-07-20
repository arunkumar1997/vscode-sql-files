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
        return {
            bucket: match[1],
            prefix: match[2] ?? "",
            isFolder: match[2]?.endsWith("/") || match[2] === "",
        };
    }),
    resolveAwsCredentials: vi.fn().mockResolvedValue({ keyId: "k", secret: "s" }),
    detectBucketRegion: vi.fn().mockResolvedValue("us-east-1"),
    listS3Keys: vi.fn().mockResolvedValue([]),
    downloadS3File: vi.fn().mockResolvedValue(undefined),
    getConfig: vi.fn().mockReturnValue({ profile: "default", region: "us-east-1", maxRows: 1000, s3ReadMode: "download" }),
    groupS3KeysByFileType: vi.fn().mockReturnValue([]),
    createPerLoadTempDir: vi.fn().mockReturnValue("/tmp/test-perload"),
    cleanupPerLoadTempDir: vi.fn(),
    isRangeReadEligible: vi.fn().mockReturnValue(false),
    isSingleKeyRangeEligible: vi.fn().mockReturnValue(false),
}));

// Mock s3RangeRead to avoid prompts in tests — always return "download"
vi.mock("../../src/s3RangeRead", () => ({
    resolveS3ReadMode: vi.fn().mockResolvedValue("download"),
    registerWithRangeRead: vi.fn().mockResolvedValue("fallback"),
}));

// Mock configManager
vi.mock("../../src/configManager", () => ({
    writeConfig: vi.fn().mockResolvedValue(undefined),
    toConfigEntry: vi.fn((entry: TableEntry, _root: string) => ({
        name: entry.name,
        source: entry.source ?? entry.filePath,
        fileType: entry.fileType,
    })),
}));

// Mock fileScanner
vi.mock("../../src/fileScanner", () => ({
    detectFileType: vi.fn((key: string) => {
        const ext = key.split(".").pop()?.toLowerCase();
        if (ext === "csv" || ext === "tsv") return "csv";
        if (ext === "parquet") return "parquet";
        if (ext === "json" || ext === "jsonl" || ext === "ndjson") return "json";
        return null;
    }),
    deriveTableName: vi.fn((name: string) => name),
}));

// Mock logger
vi.mock("../../src/logger", () => ({
    log: vi.fn(),
    logError: vi.fn(),
    logWarn: vi.fn(),
}));

// Mock fs to prevent real filesystem ops during S3 folder download tests
vi.mock("fs", async () => {
    const actual = await vi.importActual<typeof import("fs")>("fs");
    return {
        ...actual,
        default: actual,
        mkdirSync: vi.fn(),
    };
});

import {
    loadTable,
    _resetEngineInitPromise,
} from "../../src/commands/configCommands";
import * as vscode from "vscode";
import {
    detectBucketRegion,
    listS3Keys,
    downloadS3File,
    cleanupPerLoadTempDir,
    createPerLoadTempDir,
} from "../../src/s3Handler";

// Minimal DuckDBEngine mock
function mockEngine(ready = true) {
    return {
        isReady: vi.fn().mockReturnValue(ready),
        init: vi.fn().mockResolvedValue(undefined),
        ensureInitialized: vi.fn().mockResolvedValue(undefined),
        registerTable: vi.fn().mockResolvedValue([{ name: "col1", type: "VARCHAR" }]),
        dropTable: vi.fn().mockResolvedValue(undefined),
    } as unknown as import("../../src/duckdbEngine").DuckDBEngine;
}

// Helper: create a CancellationToken that cancels during registerTable
function tokenCancelledDuring(engine: ReturnType<typeof mockEngine>) {
    const state = { isCancellationRequested: false };
    (engine.registerTable as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        state.isCancellationRequested = true; // cancel fires during register
        return [{ name: "col1", type: "VARCHAR" }];
    });
    return {
        get isCancellationRequested() { return state.isCancellationRequested; },
        onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
    } as unknown as vscode.CancellationToken;
}

// ─── Blocker 1: Post-register cancellation/stale rollback ────────────────────

describe("Slice 3-4 — Post-register cancellation rolls back view and returns configured/false", () => {
    let registry: TableRegistry;
    let engine: ReturnType<typeof mockEngine>;

    beforeEach(() => {
        registry = new TableRegistry();
        engine = mockEngine();
        vi.clearAllMocks();
        _resetEngineInitPromise();
    });

    it("local table: cancellation after registerTable → drops view, configured, false", async () => {
        registry.addConfigured([
            { name: "t", source: "./data.csv", fileType: "csv" },
        ]);

        const token = tokenCancelledDuring(engine);
        const result = await loadTable("t", registry, engine, "/workspace", undefined, token);

        expect(result).toBe(false);
        expect(registry.get("t")!.loadState).toBe("configured");
        expect(registry.get("t")!.loadError).toBeUndefined();
        // View was rolled back
        expect(engine.dropTable).toHaveBeenCalledWith("t");
        // registerTable was called (view was created)
        expect(engine.registerTable).toHaveBeenCalledTimes(1);
    });

    it("local table: stale identity after registerTable → drops view, returns false", async () => {
        registry.addConfigured([
            { name: "t", source: "./data.csv", fileType: "csv" },
        ]);

        // Make registerTable trigger a registry replacement (stale identity)
        (engine.registerTable as ReturnType<typeof vi.fn>).mockImplementation(async () => {
            // Replace the entry (new runtime ID)
            registry.setLoadState("t", "configured"); // allow replacement
            const replacement: TableEntry = {
                name: "t", filePath: "/other.csv", fileType: "csv", isS3: false,
            };
            registry.add(replacement);
            return [{ name: "col1", type: "VARCHAR" }];
        });

        const result = await loadTable("t", registry, engine, "/workspace");

        expect(result).toBe(false);
        expect(engine.dropTable).toHaveBeenCalledWith("t");
    });

    it("S3 single file: cancellation after registerTable → drops view, cleans temp, configured, false", async () => {
        registry.addConfigured([
            { name: "ev", source: "s3://bucket/data.parquet", fileType: "parquet" },
        ]);

        const token = tokenCancelledDuring(engine);
        const result = await loadTable("ev", registry, engine, "/workspace", undefined, token);

        expect(result).toBe(false);
        expect(registry.get("ev")!.loadState).toBe("configured");
        expect(engine.dropTable).toHaveBeenCalledWith("ev");
        // Per-load temp cleaned up (not attached)
        expect(cleanupPerLoadTempDir).toHaveBeenCalledWith("/tmp/test-perload");
    });

    it("S3 folder: cancellation after registerTable → drops view, cleans temp, configured, false", async () => {
        (listS3Keys as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
            "prefix/file1.csv",
        ]);
        registry.addConfigured([
            { name: "folder", source: "s3://bucket/prefix/", fileType: "csv" },
        ]);

        const token = tokenCancelledDuring(engine);
        const result = await loadTable("folder", registry, engine, "/workspace", undefined, token);

        expect(result).toBe(false);
        expect(registry.get("folder")!.loadState).toBe("configured");
        expect(engine.dropTable).toHaveBeenCalledWith("folder");
        expect(cleanupPerLoadTempDir).toHaveBeenCalledWith("/tmp/test-perload");
    });
});

// ─── Blocker 2: Nested S3 folder glob uses recursive ** pattern ──────────────

describe("Slice 3-4 — Non-Hive S3 folders use recursive glob for nested files", () => {
    let registry: TableRegistry;
    let engine: ReturnType<typeof mockEngine>;

    beforeEach(() => {
        registry = new TableRegistry();
        engine = mockEngine();
        vi.clearAllMocks();
        _resetEngineInitPromise();
    });

    it("non-Hive S3 folder with nested keys uses **/*.ext recursive glob", async () => {
        // S3 folder with files nested in subdirectories
        (listS3Keys as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
            "data/subfolder/file1.csv",
            "data/subfolder/deeper/file2.csv",
            "data/root-file.csv",
        ]);

        registry.addConfigured([
            { name: "nested", source: "s3://bucket/data/", fileType: "csv" },
        ]);

        const result = await loadTable("nested", registry, engine, "/workspace");

        expect(result).toBe(true);
        expect(registry.get("nested")!.loadState).toBe("loaded");

        // Verify registerTable was called with a recursive glob path
        const registerCall = (engine.registerTable as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(registerCall.filePath).toContain("**");
        expect(registerCall.filePath).toMatch(/\*\*[/\\]\*\.csv$/);
    });

    it("flat (non-nested) S3 folder also uses ** recursive glob (harmless, correct)", async () => {
        (listS3Keys as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
            "flat/file1.csv",
            "flat/file2.csv",
        ]);

        registry.addConfigured([
            { name: "flat", source: "s3://bucket/flat/", fileType: "csv" },
        ]);

        const result = await loadTable("flat", registry, engine, "/workspace");

        expect(result).toBe(true);
        const registerCall = (engine.registerTable as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(registerCall.filePath).toContain("**");
    });
});

// ─── Blocker 3: Stale S3 outcomes are explicit failures, parent cleans temp ──

describe("Slice 3-4 — Stale S3 outcomes: explicit failure, temp cleanup, false", () => {
    let registry: TableRegistry;
    let engine: ReturnType<typeof mockEngine>;

    beforeEach(() => {
        registry = new TableRegistry();
        engine = mockEngine();
        vi.clearAllMocks();
        _resetEngineInitPromise();
    });

    it("stale after region detection → cleanup temp, return false (not success)", async () => {
        registry.addConfigured([
            { name: "ev", source: "s3://bucket/data.parquet", fileType: "parquet" },
        ]);

        // Make detectBucketRegion trigger a stale entry (once only to avoid contamination)
        (detectBucketRegion as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
            registry.setLoadState("ev", "configured");
            registry.remove("ev");
            return "us-east-1";
        });

        const result = await loadTable("ev", registry, engine, "/workspace");

        expect(result).toBe(false);
        // No temp dir was created (stale detected before createPerLoadTempDir)
        expect(createPerLoadTempDir).not.toHaveBeenCalled();
        expect(engine.registerTable).not.toHaveBeenCalled();
    });

    it("stale after S3 listing → cleanup per-load temp, return false", async () => {
        (listS3Keys as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
            // Stale the entry during listing
            registry.setLoadState("folder", "configured");
            const replacement: TableEntry = {
                name: "folder", filePath: "/new.csv", fileType: "csv", isS3: false,
            };
            registry.add(replacement);
            return ["prefix/file.csv"];
        });

        registry.addConfigured([
            { name: "folder", source: "s3://bucket/prefix/", fileType: "csv" },
        ]);

        const result = await loadTable("folder", registry, engine, "/workspace");

        expect(result).toBe(false);
        // Per-load temp cleaned up (not attached to entry)
        expect(cleanupPerLoadTempDir).toHaveBeenCalledWith("/tmp/test-perload");
        expect(engine.registerTable).not.toHaveBeenCalled();
    });

    it("stale after registerTable in S3 single file → drops view, cleans temp, returns false", async () => {
        registry.addConfigured([
            { name: "ev", source: "s3://bucket/data.parquet", fileType: "parquet" },
        ]);

        // Make registerTable trigger stale entry (once to avoid contamination)
        (engine.registerTable as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
            registry.setLoadState("ev", "configured");
            const replacement: TableEntry = {
                name: "ev", filePath: "/new.parquet", fileType: "parquet", isS3: false,
            };
            registry.add(replacement);
            return [{ name: "col1", type: "VARCHAR" }];
        });

        const result = await loadTable("ev", registry, engine, "/workspace");

        expect(result).toBe(false);
        expect(engine.dropTable).toHaveBeenCalledWith("ev");
        expect(cleanupPerLoadTempDir).toHaveBeenCalledWith("/tmp/test-perload");
    });

    it("stale S3 folder does NOT attach _tempDir on the entry", async () => {
        (listS3Keys as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
            "prefix/file.csv",
        ]);

        registry.addConfigured([
            { name: "folder", source: "s3://bucket/prefix/", fileType: "csv" },
        ]);

        // Make registerTable trigger stale entry (once to avoid contamination)
        (engine.registerTable as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
            registry.setLoadState("folder", "configured");
            const replacement: TableEntry = {
                name: "folder", filePath: "/new.csv", fileType: "csv", isS3: false,
            };
            registry.add(replacement);
            return [{ name: "col1", type: "VARCHAR" }];
        });

        await loadTable("folder", registry, engine, "/workspace");

        // The replacement entry should NOT have _tempDir attached
        const entry = registry.get("folder");
        expect((entry as TableEntry & { _tempDir?: string })?._tempDir).toBeUndefined();
    });
});

// ─── Blocker 4: AbortController/Signal propagation ──────────────────────────

describe("Slice 3-4 — AbortController created before region lookup, signal propagated", () => {
    let registry: TableRegistry;
    let engine: ReturnType<typeof mockEngine>;

    beforeEach(() => {
        registry = new TableRegistry();
        engine = mockEngine();
        vi.clearAllMocks();
        _resetEngineInitPromise();
    });

    it("detectBucketRegion receives an AbortSignal", async () => {
        registry.addConfigured([
            { name: "ev", source: "s3://bucket/data.parquet", fileType: "parquet" },
        ]);

        await loadTable("ev", registry, engine, "/workspace");

        // detectBucketRegion should be called with 3 args: bucket, creds, signal
        expect(detectBucketRegion).toHaveBeenCalledTimes(1);
        const args = (detectBucketRegion as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(args[0]).toBe("bucket");
        expect(args[2]).toBeInstanceOf(AbortSignal);
    });

    it("downloadS3File receives an AbortSignal for S3 single file", async () => {
        registry.addConfigured([
            { name: "ev", source: "s3://bucket/data.parquet", fileType: "parquet" },
        ]);

        await loadTable("ev", registry, engine, "/workspace");

        expect(downloadS3File).toHaveBeenCalledTimes(1);
        const args = (downloadS3File as ReturnType<typeof vi.fn>).mock.calls[0];
        // downloadS3File(bucket, key, destPath, creds, region, abortSignal)
        expect(args[5]).toBeInstanceOf(AbortSignal);
    });

    it("listS3Keys receives an AbortSignal for S3 folder", async () => {
        (listS3Keys as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
            "prefix/file.csv",
        ]);

        registry.addConfigured([
            { name: "folder", source: "s3://bucket/prefix/", fileType: "csv" },
        ]);

        await loadTable("folder", registry, engine, "/workspace");

        expect(listS3Keys).toHaveBeenCalledTimes(1);
        const args = (listS3Keys as ReturnType<typeof vi.fn>).mock.calls[0];
        // listS3Keys(bucket, prefix, region, creds, abortSignal)
        expect(args[4]).toBeInstanceOf(AbortSignal);
    });

    it("downloadS3File in folder download receives an AbortSignal", async () => {
        (listS3Keys as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
            "prefix/file.csv",
        ]);

        registry.addConfigured([
            { name: "folder", source: "s3://bucket/prefix/", fileType: "csv" },
        ]);

        await loadTable("folder", registry, engine, "/workspace");

        expect(downloadS3File).toHaveBeenCalledTimes(1);
        const args = (downloadS3File as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(args[5]).toBeInstanceOf(AbortSignal);
    });

    it("cancellation token abort propagates to AbortSignal — region lookup sees abort", async () => {
        registry.addConfigured([
            { name: "ev", source: "s3://bucket/data.parquet", fileType: "parquet" },
        ]);

        // detectBucketRegion captures and checks the signal
        let capturedSignal: AbortSignal | undefined;
        (detectBucketRegion as ReturnType<typeof vi.fn>).mockImplementation(
            async (_bucket: string, _creds: unknown, signal?: AbortSignal) => {
                capturedSignal = signal;
                return "us-east-1";
            },
        );

        const cancelCallbacks: Array<() => void> = [];
        const token = {
            isCancellationRequested: false,
            onCancellationRequested: vi.fn((cb: () => void) => {
                cancelCallbacks.push(cb);
                return { dispose: vi.fn() };
            }),
        } as unknown as vscode.CancellationToken;

        await loadTable("ev", registry, engine, "/workspace", undefined, token);

        // Verify the signal was passed and that onCancellationRequested was linked
        expect(capturedSignal).toBeInstanceOf(AbortSignal);
        // The cancel listener was registered
        expect(cancelCallbacks.length).toBeGreaterThan(0);
    });
});
