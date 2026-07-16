import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TableRegistry } from "../../src/tableRegistry";
import { TableEntry } from "../../src/types";

// Mock vscode before importing module under test
vi.mock("vscode", () => import("../helpers/vscode-mock"));

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
    readConfig: vi.fn().mockResolvedValue({ entries: [], diagnostics: [], missing: false }),
    writeConfig: vi.fn().mockResolvedValue(undefined),
    writeSavedQueries: vi.fn().mockResolvedValue(undefined),
    toConfigEntry: vi.fn((entry: TableEntry, _root: string) => {
        return { name: entry.name, source: entry.source ?? entry.filePath, fileType: entry.fileType };
    }),
}));
vi.mock("../../src/fileScanner", () => ({
    detectFileType: vi.fn().mockReturnValue("csv"),
    deriveTableName: vi.fn((name: string) => name),
    entryFromLocalFile: vi.fn(),
}));

import * as vscode from "vscode";

describe("Orchestration — fileSql.autoLoadLocal setting and startup/import behavior", () => {
    let registry: TableRegistry;
    let mockEngine: { ensureInitialized: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        registry = new TableRegistry();
        mockEngine = { ensureInitialized: vi.fn().mockResolvedValue(undefined) };
        vi.clearAllMocks();
    });

    afterEach(() => {
        registry.dispose();
    });

    describe("package.json contribution", () => {
        it("fileSql.autoLoadLocal defaults to true in contributes.configuration", async () => {
            const fs = await import("fs");
            const path = await import("path");
            const pkgPath = path.resolve(__dirname, "../../package.json");
            const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
            const props = pkg.contributes.configuration.properties;

            expect(props).toHaveProperty("fileSql.autoLoadLocal");
            expect(props["fileSql.autoLoadLocal"].type).toBe("boolean");
            expect(props["fileSql.autoLoadLocal"].default).toBe(true);
        });
    });

    describe("setting disabled (autoLoadLocal = false)", () => {
        beforeEach(() => {
            // Configure mock to return false for fileSql.autoLoadLocal
            const mockConfig = {
                get: vi.fn((key: string, defaultValue?: unknown) => {
                    if (key === "autoLoadLocal") return false;
                    return defaultValue;
                }),
                update: vi.fn(),
                has: vi.fn(() => true),
                inspect: vi.fn(),
            };
            (vscode.workspace.getConfiguration as ReturnType<typeof vi.fn>).mockImplementation(
                (section?: string) => {
                    if (section === "fileSql") return mockConfig;
                    return mockConfig;
                },
            );
        });

        it("startup auto-load is skipped when autoLoadLocal is false", async () => {
            registry.addConfigured([
                { name: "sales", source: "./data/sales.csv", fileType: "csv" },
            ]);

            const { triggerAutoLoadLocal: fn } = await import("../../src/commands/configCommands");
            const result = await fn(registry, mockEngine as never, "/workspace");

            expect(result).toBe(false);
            expect(vscode.window.withProgress).not.toHaveBeenCalled();
            expect(mockEngine.ensureInitialized).not.toHaveBeenCalled();
        });

        it("import-triggered auto-load is skipped when autoLoadLocal is false", async () => {
            registry.addConfigured([
                { name: "events", source: "./data/events.jsonl", fileType: "json" },
            ]);

            const { triggerAutoLoadLocal: fn } = await import("../../src/commands/configCommands");
            const result = await fn(registry, mockEngine as never, "/workspace");

            expect(result).toBe(false);
            // Engine should never be initialized if setting is disabled
            expect(mockEngine.ensureInitialized).not.toHaveBeenCalled();
        });
    });

    describe("startup auto-load gating (autoLoadLocal = true)", () => {
        beforeEach(() => {
            const mockConfig = {
                get: vi.fn((key: string, defaultValue?: unknown) => {
                    if (key === "autoLoadLocal") return true;
                    return defaultValue;
                }),
                update: vi.fn(),
                has: vi.fn(() => true),
                inspect: vi.fn(),
            };
            (vscode.workspace.getConfiguration as ReturnType<typeof vi.fn>).mockImplementation(
                () => mockConfig,
            );
        });

        it("auto-load triggers when local configured entries exist", async () => {
            registry.addConfigured([
                { name: "sales", source: "./data/sales.csv", fileType: "csv" },
            ]);

            const { triggerAutoLoadLocal: fn } = await import("../../src/commands/configCommands");
            const result = await fn(registry, mockEngine as never, "/workspace");

            expect(result).toBe(true);
            expect(vscode.window.withProgress).toHaveBeenCalled();
            expect(mockEngine.ensureInitialized).toHaveBeenCalled();
        });

        it("auto-load triggers when local error entries exist (retry on startup)", async () => {
            registry.addConfigured([
                { name: "broken", source: "./data/broken.csv", fileType: "csv" },
            ]);
            registry.setLoadState("broken", "error", "previous failure");

            const { triggerAutoLoadLocal: fn } = await import("../../src/commands/configCommands");
            const result = await fn(registry, mockEngine as never, "/workspace");

            expect(result).toBe(true);
            expect(vscode.window.withProgress).toHaveBeenCalled();
        });

        it("auto-load is NOT triggered when no configured/error entries exist", async () => {
            // Registry is empty — no local pending entries
            const { triggerAutoLoadLocal: fn } = await import("../../src/commands/configCommands");
            const result = await fn(registry, mockEngine as never, "/workspace");

            expect(result).toBe(false);
            expect(vscode.window.withProgress).not.toHaveBeenCalled();
            expect(mockEngine.ensureInitialized).not.toHaveBeenCalled();
        });

        it("all-S3 registry short-circuits without withProgress or engine init", async () => {
            // Only S3 entries — no local entries to auto-load
            registry.addConfigured([
                { name: "remote1", source: "s3://bucket/data1.parquet", fileType: "parquet" },
                { name: "remote2", source: "s3://bucket/data2.csv", fileType: "csv" },
            ]);

            const { triggerAutoLoadLocal: fn } = await import("../../src/commands/configCommands");
            const result = await fn(registry, mockEngine as never, "/workspace");

            expect(result).toBe(false);
            expect(vscode.window.withProgress).not.toHaveBeenCalled();
            expect(mockEngine.ensureInitialized).not.toHaveBeenCalled();
        });
    });

    describe("import-triggered auto-load (autoLoadLocal = true)", () => {
        beforeEach(() => {
            const mockConfig = {
                get: vi.fn((key: string, defaultValue?: unknown) => {
                    if (key === "autoLoadLocal") return true;
                    return defaultValue;
                }),
                update: vi.fn(),
                has: vi.fn(() => true),
                inspect: vi.fn(),
            };
            (vscode.workspace.getConfiguration as ReturnType<typeof vi.fn>).mockImplementation(
                () => mockConfig,
            );
        });

        it("successful explicit import triggers local auto-load when enabled", async () => {
            // Simulate: importWorkspaceConfig has just added new configured entries
            registry.addConfigured([
                { name: "imported_csv", source: "./data/imported.csv", fileType: "csv" },
                { name: "imported_json", source: "./data/imported.jsonl", fileType: "json" },
            ]);

            const { triggerAutoLoadLocal: fn } = await import("../../src/commands/configCommands");
            const result = await fn(registry, mockEngine as never, "/workspace");

            expect(result).toBe(true);
            expect(vscode.window.withProgress).toHaveBeenCalledWith(
                expect.objectContaining({
                    location: vscode.ProgressLocation.Notification,
                    cancellable: true,
                }),
                expect.any(Function),
            );
            expect(mockEngine.ensureInitialized).toHaveBeenCalled();
        });

        it("serializes overlapping triggers and loads entries added by the second pass", async () => {
            let releaseFirstLoad: (() => void) | undefined;
            const firstLoadStarted = new Promise<void>((resolve) => {
                mockEngine.ensureInitialized.mockImplementationOnce(
                    () => new Promise<void>((release) => {
                        releaseFirstLoad = release;
                        resolve();
                    }),
                );
            });
            registry.addConfigured([
                { name: "startup", source: "./startup.csv", fileType: "csv" },
            ]);

            const { triggerAutoLoadLocal: fn } = await import("../../src/commands/configCommands");
            const startupBatch = fn(registry, mockEngine as never, "/workspace");
            await firstLoadStarted;
            registry.addConfigured([
                { name: "imported", source: "./imported.csv", fileType: "csv" },
            ]);
            const importBatch = fn(registry, mockEngine as never, "/workspace");

            expect(vscode.window.withProgress).toHaveBeenCalledTimes(1);
            releaseFirstLoad!();
            await Promise.all([startupBatch, importBatch]);

            expect(vscode.window.withProgress).toHaveBeenCalledTimes(2);
            expect(registry.get("startup")!.loadState).toBe("error");
            expect(registry.get("imported")!.loadState).toBe("error");
        });
    });
});
