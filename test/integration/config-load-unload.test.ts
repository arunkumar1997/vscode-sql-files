import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import path from "path";
import { createEngine, EngineHarness } from "../helpers/duckdbHarness";
import { TableRegistry } from "../../src/tableRegistry";
import { ConfigTableEntry, TableEntry } from "../../src/types";

// Mock vscode for configCommands (which imports vscode)
vi.mock("vscode", () => import("../helpers/vscode-mock"));
// Mock s3Handler (not used in local integration test but imported)
vi.mock("../../src/s3Handler", () => ({
    parseS3Uri: vi.fn(),
    resolveAwsCredentials: vi.fn(),
    detectBucketRegion: vi.fn(),
    listS3Keys: vi.fn(),
    downloadS3Entries: vi.fn(),
    downloadS3Folder: vi.fn(),
    downloadS3HiveFolder: vi.fn(),
    findHivePartitionPrefixes: vi.fn(),
    groupKeysByLeafPrefix: vi.fn(),
    groupS3KeysByFileType: vi.fn(),
    getConfig: vi.fn().mockReturnValue({ profile: "default", region: "us-east-1", maxRows: 1000 }),
}));
vi.mock("../../src/logger", () => ({
    log: vi.fn(),
    logError: vi.fn(),
    logWarn: vi.fn(),
}));
vi.mock("../../src/configManager", () => ({
    readConfig: vi.fn(),
    writeConfig: vi.fn().mockResolvedValue(undefined),
    toConfigEntry: vi.fn((entry: TableEntry, wsRoot: string) => {
        const posixRoot = wsRoot.replace(/\\/g, "/");
        const posixFile = entry.filePath.replace(/\\/g, "/");
        const prefix = posixRoot.endsWith("/") ? posixRoot : posixRoot + "/";
        if (!posixFile.startsWith(prefix)) return null;
        return { name: entry.name, source: "./" + posixFile.slice(prefix.length), fileType: entry.fileType };
    }),
}));

import { importWorkspaceConfig, loadTable, unloadTable, reloadTable, saveWorkspaceConfig } from "../../src/commands/configCommands";
import * as vscode from "vscode";
import { readConfig, writeConfig } from "../../src/configManager";

describe("Integration — config load/unload cycle with real DuckDB", () => {
    let harness: EngineHarness;
    let registry: TableRegistry;

    beforeEach(async () => {
        harness = await createEngine();
        registry = new TableRegistry();
        vi.clearAllMocks();
    });

    afterEach(() => {
        harness?.dispose();
        registry?.dispose();
    });

    it("loads a configured local CSV, queries it, unloads it", async () => {
        // Setup: add a configured entry with relative source
        const configs: ConfigTableEntry[] = [
            { name: "sales", source: "./test/fixtures/sales.csv", fileType: "csv" },
        ];
        registry.addConfigured(configs);
        expect(registry.get("sales")!.loadState).toBe("configured");

        // Load: uses workspace root to resolve relative path
        const wsRoot = path.resolve(__dirname, "../..");
        const loaded = await loadTable("sales", registry, harness.engine, wsRoot);
        expect(loaded).toBe(true);
        expect(registry.get("sales")!.loadState).toBe("loaded");
        expect(registry.get("sales")!.columns!.length).toBeGreaterThan(0);

        // Query: verify data is accessible
        const result = await harness.engine.executeQuery("SELECT COUNT(*) AS cnt FROM sales", 100);
        expect(Number(result.rows[0].cnt)).toBe(5);

        // Unload: drops view, clears columns
        const unloaded = await unloadTable("sales", registry, harness.engine);
        expect(unloaded).toBe(true);
        expect(registry.get("sales")!.loadState).toBe("configured");
        expect(registry.get("sales")!.columns).toBeUndefined();

        // Confirm query fails after unload (view dropped)
        await expect(
            harness.engine.executeQuery("SELECT * FROM sales", 10),
        ).rejects.toThrow();
    });

    it("reload cycle: unloads then re-registers table", async () => {
        const wsRoot = path.resolve(__dirname, "../..");
        registry.addConfigured([
            { name: "sales_r", source: "./test/fixtures/sales.csv", fileType: "csv" },
        ]);

        // Load first
        await loadTable("sales_r", registry, harness.engine, wsRoot);
        expect(registry.get("sales_r")!.loadState).toBe("loaded");

        // Reload
        const reloaded = await reloadTable("sales_r", registry, harness.engine, wsRoot);
        expect(reloaded).toBe(true);
        expect(registry.get("sales_r")!.loadState).toBe("loaded");

        // Still queryable
        const result = await harness.engine.executeQuery("SELECT COUNT(*) AS cnt FROM sales_r", 100);
        expect(Number(result.rows[0].cnt)).toBe(5);
    });

    it("loads multiple configured tables individually, continues after failure", async () => {
        const wsRoot = path.resolve(__dirname, "../..");
        registry.addConfigured([
            { name: "sales_la", source: "./test/fixtures/sales.csv", fileType: "csv" },
            { name: "bad_la", source: "./nonexistent/file.csv", fileType: "csv" },
            { name: "events_la", source: "./test/fixtures/events.jsonl", fileType: "json" },
        ]);

        await loadTable("sales_la", registry, harness.engine, wsRoot);
        await loadTable("bad_la", registry, harness.engine, wsRoot);
        await loadTable("events_la", registry, harness.engine, wsRoot);

        expect(registry.get("sales_la")!.loadState).toBe("loaded");
        expect(registry.get("bad_la")!.loadState).toBe("error");
        expect(registry.get("events_la")!.loadState).toBe("loaded");
    });

    it("import restores a runtime-deleted table without loading it", async () => {
        const wsRoot = path.resolve(__dirname, "../..");
        const wsUri = { fsPath: wsRoot } as vscode.Uri;
        const { DuckDBEngine } = await import("../../src/duckdbEngine");
        const freshEngine = new DuckDBEngine();
        vi.mocked(readConfig).mockResolvedValue({
            entries: [
                { name: "restored", source: "./test/fixtures/sales.csv", fileType: "csv" },
            ],
            diagnostics: [],
            missing: false,
        });

        registry.addConfigured([
            { name: "restored", source: "./test/fixtures/sales.csv", fileType: "csv" },
        ]);
        registry.remove("restored");

        const imported = await importWorkspaceConfig(registry, wsUri);

        expect(imported).toBe(true);
        expect(readConfig).toHaveBeenCalledWith(wsUri);
        expect(registry.get("restored")?.loadState).toBe("configured");
        expect(registry.get("restored")?.columns).toBeUndefined();
        expect(freshEngine.isReady()).toBe(false);
        freshEngine.dispose();
    });

    it("blocks duplicate load of same table", async () => {
        const wsRoot = path.resolve(__dirname, "../..");
        registry.addConfigured([
            { name: "dup", source: "./test/fixtures/sales.csv", fileType: "csv" },
        ]);

        // Load once
        await loadTable("dup", registry, harness.engine, wsRoot);
        expect(registry.get("dup")!.loadState).toBe("loaded");

        // Try loading again — should be blocked
        const second = await loadTable("dup", registry, harness.engine, wsRoot);
        expect(second).toBe(false);
    });

    it("lazy engine init on first load when engine not yet ready", async () => {
        // Create a fresh un-initialized engine  
        const { DuckDBEngine } = await import("../../src/duckdbEngine");
        const freshEngine = new DuckDBEngine();
        expect(freshEngine.isReady()).toBe(false);

        const wsRoot = path.resolve(__dirname, "../..");
        registry.addConfigured([
            { name: "lazy", source: "./test/fixtures/sales.csv", fileType: "csv" },
        ]);

        // loadTable should init the engine lazily
        const result = await loadTable("lazy", registry, freshEngine, wsRoot);
        expect(result).toBe(true);
        expect(freshEngine.isReady()).toBe(true);
        expect(registry.get("lazy")!.loadState).toBe("loaded");

        freshEngine.dispose();
    });
});

describe("Integration — saveWorkspaceConfig with real registry", () => {
    let registry: TableRegistry;

    beforeEach(() => {
        registry = new TableRegistry();
        vi.clearAllMocks();
    });

    afterEach(() => {
        registry?.dispose();
    });

    it("saves adhoc entries as config entries", async () => {
        const wsRoot = path.resolve(__dirname, "../..");

        registry.add({
            name: "sales_save",
            filePath: path.join(wsRoot, "test/fixtures/sales.csv"),
            fileType: "csv",
            isS3: false,
        });

        const wsUri = { scheme: "file", fsPath: wsRoot, path: wsRoot, toString: () => `file://${wsRoot}` } as unknown as vscode.Uri;
        const result = await saveWorkspaceConfig(registry, wsUri);

        expect(result).toBe(true);
        expect(writeConfig).toHaveBeenCalledTimes(1);
        const writtenEntries = (writeConfig as ReturnType<typeof vi.fn>).mock.calls[0][1];
        expect(writtenEntries).toHaveLength(1);
        expect(writtenEntries[0].name).toBe("sales_save");
        expect(writtenEntries[0].source).toContain("test/fixtures/sales.csv");
    });
});
