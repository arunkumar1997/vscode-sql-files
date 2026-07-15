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

// Mock configManager writeConfig and toConfigEntry
vi.mock("../../src/configManager", () => ({
    writeConfig: vi.fn().mockResolvedValue(undefined),
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

import {
    loadTable,
    loadAllTables,
    unloadTable,
    reloadTable,
    saveWorkspaceConfig,
} from "../../src/commands/configCommands";
import * as vscode from "vscode";
import { writeConfig, toConfigEntry } from "../../src/configManager";

// Minimal DuckDBEngine mock
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



describe("configCommands — loadTable", () => {
    let registry: TableRegistry;
    let engine: ReturnType<typeof mockEngine>;

    beforeEach(() => {
        registry = new TableRegistry();
        engine = mockEngine();
        vi.clearAllMocks();
    });

    it("loads a configured local table → loaded state", async () => {
        registry.addConfigured([
            { name: "sales", source: "./data/sales.csv", fileType: "csv" },
        ]);
        expect(registry.get("sales")!.loadState).toBe("configured");

        const result = await loadTable("sales", registry, engine, "/workspace");

        expect(result).toBe(true);
        expect(registry.get("sales")!.loadState).toBe("loaded");
        expect(registry.get("sales")!.columns).toEqual([{ name: "col1", type: "VARCHAR" }]);
        expect(engine.registerTable).toHaveBeenCalledTimes(1);
    });

    it("resolves relative source against workspace root", async () => {
        registry.addConfigured([
            { name: "data", source: "./sub/data.csv", fileType: "csv" },
        ]);

        await loadTable("data", registry, engine, "/workspace");

        const call = (engine.registerTable as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(call.filePath).toMatch(/\/workspace\/sub\/data\.csv$/);
    });

    it("rejects loading an already loaded table", async () => {
        registry.addConfigured([
            { name: "sales", source: "./data/sales.csv", fileType: "csv" },
        ]);
        registry.setLoadState("sales", "loaded");

        const result = await loadTable("sales", registry, engine, "/workspace");

        expect(result).toBe(false);
        expect(engine.registerTable).not.toHaveBeenCalled();
    });

    it("rejects loading a table that is already loading (duplicate load)", async () => {
        registry.addConfigured([
            { name: "sales", source: "./data/sales.csv", fileType: "csv" },
        ]);
        registry.setLoadState("sales", "loading");

        const result = await loadTable("sales", registry, engine, "/workspace");

        expect(result).toBe(false);
        expect(engine.registerTable).not.toHaveBeenCalled();
    });

    it("loads a table in error state (retry)", async () => {
        registry.addConfigured([
            { name: "sales", source: "./data/sales.csv", fileType: "csv" },
        ]);
        registry.setLoadState("sales", "error", "previous failure");

        const result = await loadTable("sales", registry, engine, "/workspace");

        expect(result).toBe(true);
        expect(registry.get("sales")!.loadState).toBe("loaded");
        expect(registry.get("sales")!.loadError).toBeUndefined();
    });

    it("transitions to error state on registerTable failure", async () => {
        registry.addConfigured([
            { name: "bad", source: "./bad.csv", fileType: "csv" },
        ]);
        (engine.registerTable as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
            new Error("file not found"),
        );

        const result = await loadTable("bad", registry, engine, "/workspace");

        expect(result).toBe(false);
        expect(registry.get("bad")!.loadState).toBe("error");
        expect(registry.get("bad")!.loadError).toBe("file not found");
    });

    it("returns false for non-existent table", async () => {
        const result = await loadTable("ghost", registry, engine, "/workspace");
        expect(result).toBe(false);
    });

    it("lazy-inits engine via ensureInitialized", async () => {
        registry.addConfigured([
            { name: "x", source: "./x.csv", fileType: "csv" },
        ]);

        const result = await loadTable("x", registry, engine, "/workspace");

        expect(engine.ensureInitialized).toHaveBeenCalled();
        expect(result).toBe(true);
    });

    it("sets error state if engine init fails", async () => {
        engine = mockEngine(false);
        (engine.ensureInitialized as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
            new Error("init failed"),
        );

        registry.addConfigured([
            { name: "x", source: "./x.csv", fileType: "csv" },
        ]);

        const result = await loadTable("x", registry, engine, "/workspace");

        expect(result).toBe(false);
        expect(registry.get("x")!.loadState).toBe("error");
        expect(registry.get("x")!.loadError).toBe("DuckDB failed to initialize");
    });

    it("respects cancellation token", async () => {
        registry.addConfigured([
            { name: "x", source: "./x.csv", fileType: "csv" },
        ]);

        const token = { isCancellationRequested: true, onCancellationRequested: vi.fn() };
        const result = await loadTable(
            "x", registry, engine, "/workspace", undefined, token as unknown as vscode.CancellationToken,
        );

        expect(result).toBe(false);
        expect(registry.get("x")!.loadState).toBe("configured");
        expect(engine.registerTable).not.toHaveBeenCalled();
    });
});

describe("configCommands — unloadTable", () => {
    let registry: TableRegistry;
    let engine: ReturnType<typeof mockEngine>;

    beforeEach(() => {
        registry = new TableRegistry();
        engine = mockEngine();
        vi.clearAllMocks();
    });

    it("drops view, clears columns, returns to configured", async () => {
        registry.addConfigured([
            { name: "sales", source: "./data/sales.csv", fileType: "csv" },
        ]);
        registry.setLoadState("sales", "loaded");
        registry.get("sales")!.columns = [{ name: "c", type: "VARCHAR" }];

        const result = await unloadTable("sales", registry, engine);

        expect(result).toBe(true);
        expect(registry.get("sales")!.loadState).toBe("configured");
        expect(registry.get("sales")!.columns).toBeUndefined();
        expect(engine.dropTable).toHaveBeenCalledWith("sales");
    });

    it("rejects unloading a configured table", async () => {
        registry.addConfigured([
            { name: "sales", source: "./data/sales.csv", fileType: "csv" },
        ]);

        const result = await unloadTable("sales", registry, engine);

        expect(result).toBe(false);
        expect(engine.dropTable).not.toHaveBeenCalled();
    });

    it("rejects unloading a loading table", async () => {
        registry.addConfigured([
            { name: "x", source: "./x.csv", fileType: "csv" },
        ]);
        registry.setLoadState("x", "loading");

        const result = await unloadTable("x", registry, engine);

        expect(result).toBe(false);
    });

    it("unloads error state tables", async () => {
        registry.addConfigured([
            { name: "x", source: "./x.csv", fileType: "csv" },
        ]);
        registry.setLoadState("x", "error", "some error");

        const result = await unloadTable("x", registry, engine);

        expect(result).toBe(true);
        expect(registry.get("x")!.loadState).toBe("configured");
    });

    it("resets S3 filePath to source on unload", async () => {
        registry.addConfigured([
            { name: "ev", source: "s3://bucket/events/", fileType: "parquet" },
        ]);
        registry.setLoadState("ev", "loaded");
        registry.get("ev")!.filePath = "/tmp/some-temp-path/glob.parquet";

        await unloadTable("ev", registry, engine);

        expect(registry.get("ev")!.filePath).toBe("s3://bucket/events/");
    });

    it("returns false for non-existent table", async () => {
        const result = await unloadTable("ghost", registry, engine);
        expect(result).toBe(false);
    });
});

describe("configCommands — reloadTable", () => {
    let registry: TableRegistry;
    let engine: ReturnType<typeof mockEngine>;

    beforeEach(() => {
        registry = new TableRegistry();
        engine = mockEngine();
        vi.clearAllMocks();
    });

    it("unloads then reloads a loaded table", async () => {
        registry.addConfigured([
            { name: "sales", source: "./data/sales.csv", fileType: "csv" },
        ]);
        registry.setLoadState("sales", "loaded");
        registry.get("sales")!.columns = [{ name: "c", type: "VARCHAR" }];

        const result = await reloadTable("sales", registry, engine, "/workspace");

        expect(result).toBe(true);
        expect(registry.get("sales")!.loadState).toBe("loaded");
        expect(engine.dropTable).toHaveBeenCalledWith("sales");
        expect(engine.registerTable).toHaveBeenCalledTimes(1);
    });

    it("rejects reload during loading", async () => {
        registry.addConfigured([
            { name: "x", source: "./x.csv", fileType: "csv" },
        ]);
        registry.setLoadState("x", "loading");

        const result = await reloadTable("x", registry, engine, "/workspace");

        expect(result).toBe(false);
    });

    it("returns false for non-existent table", async () => {
        const result = await reloadTable("ghost", registry, engine, "/workspace");
        expect(result).toBe(false);
    });
});

describe("configCommands — loadAllTables", () => {
    let registry: TableRegistry;
    let engine: ReturnType<typeof mockEngine>;

    beforeEach(() => {
        registry = new TableRegistry();
        engine = mockEngine();
        vi.clearAllMocks();
    });

    it("loads all configured tables", async () => {
        registry.addConfigured([
            { name: "a", source: "./a.csv", fileType: "csv" },
            { name: "b", source: "./b.csv", fileType: "csv" },
        ]);

        await loadAllTables(registry, engine, "/workspace");

        expect(registry.get("a")!.loadState).toBe("loaded");
        expect(registry.get("b")!.loadState).toBe("loaded");
        expect(engine.registerTable).toHaveBeenCalledTimes(2);
    });

    it("continues after individual failures", async () => {
        registry.addConfigured([
            { name: "a", source: "./a.csv", fileType: "csv" },
            { name: "b", source: "./b.csv", fileType: "csv" },
        ]);
        (engine.registerTable as ReturnType<typeof vi.fn>)
            .mockRejectedValueOnce(new Error("fail a"))
            .mockResolvedValueOnce([{ name: "col", type: "INT" }]);

        await loadAllTables(registry, engine, "/workspace");

        expect(registry.get("a")!.loadState).toBe("error");
        expect(registry.get("b")!.loadState).toBe("loaded");
    });

    it("skips already-loaded tables", async () => {
        registry.addConfigured([
            { name: "a", source: "./a.csv", fileType: "csv" },
            { name: "b", source: "./b.csv", fileType: "csv" },
        ]);
        registry.setLoadState("a", "loaded");

        await loadAllTables(registry, engine, "/workspace");

        // Only b should be loaded
        expect(engine.registerTable).toHaveBeenCalledTimes(1);
        const call = (engine.registerTable as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(call.name).toBe("b");
    });

    it("shows info message when no tables to load", async () => {
        await loadAllTables(registry, engine, "/workspace");
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
            "File SQL: No tables to load.",
        );
    });

    it("loads error-state tables (retry all)", async () => {
        registry.addConfigured([
            { name: "x", source: "./x.csv", fileType: "csv" },
        ]);
        registry.setLoadState("x", "error", "old error");

        await loadAllTables(registry, engine, "/workspace");

        expect(registry.get("x")!.loadState).toBe("loaded");
    });
});

describe("configCommands — saveWorkspaceConfig", () => {
    let registry: TableRegistry;

    beforeEach(() => {
        registry = new TableRegistry();
        vi.clearAllMocks();
    });

    it("saves all entries to config via writeConfig", async () => {
        // Add a regular adhoc entry
        registry.add({
            name: "sales",
            filePath: "/workspace/data/sales.csv",
            fileType: "csv",
            isS3: false,
            source: "./data/sales.csv",
        });

        const wsRoot = { scheme: "file", fsPath: "/workspace", path: "/workspace", toString: () => "file:///workspace" } as unknown as vscode.Uri;
        const result = await saveWorkspaceConfig(registry, wsRoot);

        expect(result).toBe(true);
        expect(writeConfig).toHaveBeenCalledTimes(1);
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
            expect.stringContaining("saved to .filesql/config.json"),
        );
    });

    it("warns if no entries can be saved", async () => {
        // Add an S3 entry with no source (toConfigEntry returns null)
        registry.add({
            name: "bad",
            filePath: "/tmp/bad.csv",
            fileType: "csv",
            isS3: true,
        });
        // Mock toConfigEntry to return null
        (toConfigEntry as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);

        const wsRoot = { scheme: "file", fsPath: "/workspace", path: "/workspace", toString: () => "file:///workspace" } as unknown as vscode.Uri;
        const result = await saveWorkspaceConfig(registry, wsRoot);

        expect(result).toBe(false);
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("cannot be represented"),
        );
    });

    it("shows error message on write failure", async () => {
        registry.add({
            name: "x",
            filePath: "/workspace/x.csv",
            fileType: "csv",
            isS3: false,
            source: "./x.csv",
        });
        (writeConfig as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
            new Error("disk full"),
        );

        const wsRoot = { scheme: "file", fsPath: "/workspace", path: "/workspace", toString: () => "file:///workspace" } as unknown as vscode.Uri;
        const result = await saveWorkspaceConfig(registry, wsRoot);

        expect(result).toBe(false);
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("disk full"),
        );
    });

    it("saves empty config when registry is empty (no warning)", async () => {
        const wsRoot = { scheme: "file", fsPath: "/workspace", path: "/workspace", toString: () => "file:///workspace" } as unknown as vscode.Uri;
        const result = await saveWorkspaceConfig(registry, wsRoot);

        expect(result).toBe(true);
        expect(writeConfig).toHaveBeenCalledWith(wsRoot, []);
    });
});
