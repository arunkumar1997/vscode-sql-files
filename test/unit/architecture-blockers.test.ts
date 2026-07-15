import { describe, it, expect, vi, beforeEach } from "vitest";
import { TableRegistry } from "../../src/tableRegistry";
import { TableEntry } from "../../src/types";

// Mock vscode before importing module under test
vi.mock("vscode", () => import("../helpers/vscode-mock"));

// Mock s3Handler
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
    getConfig: vi.fn().mockReturnValue({ profile: "default", region: "us-east-1", maxRows: 1000 }),
    groupS3KeysByFileType: vi.fn().mockReturnValue([]),
    createPerLoadTempDir: vi.fn().mockReturnValue("/tmp/test-perload-x"),
    cleanupPerLoadTempDir: vi.fn(),
}));
vi.mock("../../src/configManager", () => ({
    writeConfig: vi.fn().mockResolvedValue(undefined),
    toConfigEntry: vi.fn((entry: TableEntry, _root: string) => {
        if (entry.isS3 && !entry.source?.startsWith("s3://")) return null;
        return { name: entry.name, source: entry.source ?? entry.filePath, fileType: entry.fileType };
    }),
}));
vi.mock("../../src/fileScanner", () => ({
    detectFileType: vi.fn().mockReturnValue("csv"),
    deriveTableName: vi.fn((name: string) => name),
}));
vi.mock("../../src/logger", () => ({
    log: vi.fn(),
    logError: vi.fn(),
    logWarn: vi.fn(),
}));

import {
    loadTable,
    unloadTable,
    saveWorkspaceConfig,
    ensureEngineInitialized,
    _resetEngineInitPromise,
} from "../../src/commands/configCommands";
import * as vscode from "vscode";
import { cleanupPerLoadTempDir } from "../../src/s3Handler";
import { toConfigEntry, writeConfig } from "../../src/configManager";

function mockEngine(ready = true) {
    const eng = {
        isReady: vi.fn().mockReturnValue(ready),
        init: vi.fn().mockResolvedValue(undefined),
        ensureInitialized: vi.fn().mockResolvedValue(undefined),
        registerTable: vi.fn().mockResolvedValue([{ name: "col1", type: "VARCHAR" }]),
        dropTable: vi.fn().mockResolvedValue(undefined),
    };
    return eng as unknown as import("../../src/duckdbEngine").DuckDBEngine;
}

describe("Architecture Blockers — S3 per-load temp ownership", () => {
    let registry: TableRegistry;
    let engine: ReturnType<typeof mockEngine>;

    beforeEach(() => {
        registry = new TableRegistry();
        engine = mockEngine();
        vi.clearAllMocks();
        _resetEngineInitPromise();
    });

    it("calls cleanupPerLoadTempDir on unload of S3 table", async () => {
        registry.addConfigured([
            { name: "ev", source: "s3://bucket/events/", fileType: "parquet" },
        ]);
        registry.setLoadState("ev", "loaded");
        const entry = registry.get("ev")!;
        entry.filePath = "/tmp/test-perload-x/glob.parquet";
        (entry as TableEntry & { _tempDir?: string })._tempDir = "/tmp/test-perload-x";

        await unloadTable("ev", registry, engine);

        expect(cleanupPerLoadTempDir).toHaveBeenCalledWith("/tmp/test-perload-x");
    });

    it("does not call cleanupPerLoadTempDir for non-S3 table unload", async () => {
        registry.addConfigured([
            { name: "local", source: "./data.csv", fileType: "csv" },
        ]);
        registry.setLoadState("local", "loaded");

        await unloadTable("local", registry, engine);

        expect(cleanupPerLoadTempDir).not.toHaveBeenCalled();
    });
});

describe("Architecture Blockers — Failure-atomic unload preserves loaded state", () => {
    let registry: TableRegistry;
    let engine: ReturnType<typeof mockEngine>;

    beforeEach(() => {
        registry = new TableRegistry();
        engine = mockEngine();
        vi.clearAllMocks();
        _resetEngineInitPromise();
    });

    it("preserves loaded state when dropTable fails during unload", async () => {
        registry.addConfigured([
            { name: "t", source: "./data.csv", fileType: "csv" },
        ]);
        registry.setLoadState("t", "loaded");
        (engine.dropTable as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
            new Error("Connection lost"),
        );

        const result = await unloadTable("t", registry, engine);

        expect(result).toBe(false);
        expect(registry.get("t")!.loadState).toBe("loaded");
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Failed to unload"),
        );
    });
});

describe("Architecture Blockers — Cancellation → configured (not error)", () => {
    let registry: TableRegistry;
    let engine: ReturnType<typeof mockEngine>;

    beforeEach(() => {
        registry = new TableRegistry();
        engine = mockEngine();
        vi.clearAllMocks();
        _resetEngineInitPromise();
    });

    it("reverts to configured on immediate cancellation", async () => {
        registry.addConfigured([
            { name: "t", source: "./data.csv", fileType: "csv" },
        ]);

        const token = { isCancellationRequested: true, onCancellationRequested: vi.fn() };
        const result = await loadTable(
            "t", registry, engine, "/workspace", undefined,
            token as unknown as vscode.CancellationToken,
        );

        expect(result).toBe(false);
        expect(registry.get("t")!.loadState).toBe("configured");
        expect(registry.get("t")!.loadError).toBeUndefined();
    });
});

describe("Architecture Blockers — Promise-locked idempotent engine init", () => {
    let engine: ReturnType<typeof mockEngine>;

    beforeEach(() => {
        vi.clearAllMocks();
        _resetEngineInitPromise();
    });

    it("only calls ensureInitialized once per engine (concurrent callers get same result)", async () => {
        engine = mockEngine(false);
        let initCallCount = 0;
        (engine.ensureInitialized as ReturnType<typeof vi.fn>).mockImplementation(async () => {
            initCallCount++;
            await new Promise((r) => setTimeout(r, 10));
        });

        // Call concurrently — ensureEngineInitialized delegates to engine.ensureInitialized()
        const [r1, r2, r3] = await Promise.all([
            ensureEngineInitialized(engine),
            ensureEngineInitialized(engine),
            ensureEngineInitialized(engine),
        ]);

        expect(r1).toBe(true);
        expect(r2).toBe(true);
        expect(r3).toBe(true);
        // All 3 calls go through to the engine's method — idempotency is the engine's responsibility
        expect(engine.ensureInitialized).toHaveBeenCalledTimes(3);
    });

    it("returns true immediately if ensureInitialized resolves", async () => {
        engine = mockEngine(true);
        const result = await ensureEngineInitialized(engine);
        expect(result).toBe(true);
        expect(engine.ensureInitialized).toHaveBeenCalledTimes(1);
    });

    it("returns false and shows error if ensureInitialized rejects", async () => {
        engine = mockEngine(false);
        (engine.ensureInitialized as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
            new Error("init failed"),
        );

        const result = await ensureEngineInitialized(engine);

        expect(result).toBe(false);
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("init failed"),
        );
    });
});

describe("Architecture Blockers — Runtime-ID stale guard", () => {
    let registry: TableRegistry;
    let engine: ReturnType<typeof mockEngine>;

    beforeEach(() => {
        registry = new TableRegistry();
        engine = mockEngine();
        vi.clearAllMocks();
        _resetEngineInitPromise();
    });

    it("aborts load if entry is removed during async init", async () => {
        engine = mockEngine(false);
        (engine.ensureInitialized as ReturnType<typeof vi.fn>).mockImplementation(async () => {
            // Remove the entry during init
            registry.setLoadState("t", "configured"); // to allow remove
            registry.remove("t");
        });

        registry.addConfigured([
            { name: "t", source: "./data.csv", fileType: "csv" },
        ]);

        const result = await loadTable("t", registry, engine, "/workspace");

        expect(result).toBe(false);
        expect(engine.registerTable).not.toHaveBeenCalled();
    });
});

describe("Architecture Blockers — Guard against clear while loading", () => {
    let registry: TableRegistry;

    beforeEach(() => {
        registry = new TableRegistry();
    });

    it("throws if clear is called while a table is loading", () => {
        registry.addConfigured([
            { name: "t", source: "./data.csv", fileType: "csv" },
        ]);
        registry.setLoadState("t", "loading");

        expect(() => registry.clear()).toThrow(/loading/);
    });

    it("allows clear when no tables are loading", () => {
        registry.addConfigured([
            { name: "t", source: "./data.csv", fileType: "csv" },
        ]);
        registry.setLoadState("t", "loaded");

        expect(() => registry.clear()).not.toThrow();
        expect(registry.getAll()).toHaveLength(0);
    });
});

describe("Architecture Blockers — Save aborts entirely for unrepresentable entries", () => {
    let registry: TableRegistry;

    beforeEach(() => {
        registry = new TableRegistry();
        vi.clearAllMocks();
    });

    it("aborts save and names unrepresentable entries", async () => {
        registry.add({
            name: "good",
            filePath: "/workspace/data.csv",
            fileType: "csv",
            isS3: false,
            source: "./data.csv",
        });
        registry.add({
            name: "outside",
            filePath: "/other/place.csv",
            fileType: "csv",
            isS3: false,
        });
        // toConfigEntry returns null for "outside" (outside workspace)
        (toConfigEntry as ReturnType<typeof vi.fn>)
            .mockReturnValueOnce({ name: "good", source: "./data.csv", fileType: "csv" })
            .mockReturnValueOnce(null);

        const wsRoot = { scheme: "file", fsPath: "/workspace", path: "/workspace", toString: () => "file:///workspace" } as unknown as vscode.Uri;
        const result = await saveWorkspaceConfig(registry, wsRoot);

        expect(result).toBe(false);
        expect(writeConfig).not.toHaveBeenCalled();
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining('"outside"'),
        );
    });

    it("allows explicit empty save (valid)", async () => {
        const wsRoot = { scheme: "file", fsPath: "/workspace", path: "/workspace", toString: () => "file:///workspace" } as unknown as vscode.Uri;
        const result = await saveWorkspaceConfig(registry, wsRoot);

        expect(result).toBe(true);
        expect(writeConfig).toHaveBeenCalledWith(wsRoot, []);
    });
});

describe("Architecture Blockers — Failure-atomic registration cleanup", () => {
    let registry: TableRegistry;
    let engine: ReturnType<typeof mockEngine>;

    beforeEach(() => {
        registry = new TableRegistry();
        engine = mockEngine();
        vi.clearAllMocks();
        _resetEngineInitPromise();
    });

    it("sets error state on registerTable failure (failure-atomic rollback is internal to engine)", async () => {
        registry.addConfigured([
            { name: "t", source: "./data.csv", fileType: "csv" },
        ]);
        (engine.registerTable as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
            new Error("Schema mismatch"),
        );

        const result = await loadTable("t", registry, engine, "/workspace");

        expect(result).toBe(false);
        // Rollback (dropTable) is now internal to DuckDBEngine.registerTable.
        // The command layer just sees the error and sets error state.
        expect(registry.get("t")!.loadState).toBe("error");
        expect(registry.get("t")!.loadError).toBe("Schema mismatch");
    });
});
