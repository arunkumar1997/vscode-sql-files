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
    createPerLoadTempDir: vi.fn().mockReturnValue("/tmp/test-perload"),
    cleanupPerLoadTempDir: vi.fn(),
}));
vi.mock("../../src/logger", () => ({
    log: vi.fn(),
    logError: vi.fn(),
    logWarn: vi.fn(),
}));
vi.mock("../../src/configManager", () => ({
    readConfig: vi.fn(),
    writeConfig: vi.fn().mockResolvedValue(undefined),
    writeSavedQueries: vi.fn().mockResolvedValue(undefined),
    toConfigEntry: vi.fn((entry: TableEntry, wsRoot: string) => {
        const posixRoot = wsRoot.replace(/\\/g, "/");
        const posixFile = entry.filePath.replace(/\\/g, "/");
        const prefix = posixRoot.endsWith("/") ? posixRoot : posixRoot + "/";
        if (!posixFile.startsWith(prefix)) return null;
        return { name: entry.name, source: "./" + posixFile.slice(prefix.length), fileType: entry.fileType };
    }),
}));

import { autoLoadConfiguredLocalTables } from "../../src/commands/configCommands";

describe("Integration — autoLoadConfiguredLocalTables with real DuckDB", () => {
    let harness: EngineHarness;
    let registry: TableRegistry;
    const wsRoot = path.resolve(__dirname, "../..");

    beforeEach(async () => {
        harness = await createEngine();
        registry = new TableRegistry();
        vi.clearAllMocks();
    });

    afterEach(() => {
        harness?.dispose();
        registry?.dispose();
    });

    it("auto-loads local CSV and JSON entries with columns, leaves S3 configured", async () => {
        const configs: ConfigTableEntry[] = [
            { name: "sales", source: "./test/fixtures/sales.csv", fileType: "csv" },
            { name: "events", source: "./test/fixtures/events.jsonl", fileType: "json" },
            { name: "s3_remote", source: "s3://my-bucket/data/file.parquet", fileType: "parquet" },
        ];
        registry.addConfigured(configs);

        // Verify initial state
        expect(registry.get("sales")!.loadState).toBe("configured");
        expect(registry.get("events")!.loadState).toBe("configured");
        expect(registry.get("s3_remote")!.loadState).toBe("configured");

        await autoLoadConfiguredLocalTables(registry, harness.engine, wsRoot);

        // Local CSV: loaded with columns
        const sales = registry.get("sales")!;
        expect(sales.loadState).toBe("loaded");
        expect(sales.columns).toBeDefined();
        expect(sales.columns!.length).toBeGreaterThan(0);

        // Local JSON: loaded with columns
        const events = registry.get("events")!;
        expect(events.loadState).toBe("loaded");
        expect(events.columns).toBeDefined();
        expect(events.columns!.length).toBeGreaterThan(0);

        // S3: still configured (lazy)
        expect(registry.get("s3_remote")!.loadState).toBe("configured");
        expect(registry.get("s3_remote")!.columns).toBeUndefined();

        // Verify data is actually queryable
        const result = await harness.engine.executeQuery("SELECT COUNT(*) AS cnt FROM sales", 100);
        expect(Number(result.rows[0].cnt)).toBeGreaterThan(0);
    });

    it("loads entries in error state on retry", async () => {
        registry.addConfigured([
            { name: "sales_retry", source: "./test/fixtures/sales.csv", fileType: "csv" },
        ]);
        registry.setLoadState("sales_retry", "error", "previous problem");

        await autoLoadConfiguredLocalTables(registry, harness.engine, wsRoot);

        expect(registry.get("sales_retry")!.loadState).toBe("loaded");
        expect(registry.get("sales_retry")!.columns!.length).toBeGreaterThan(0);
    });
});
