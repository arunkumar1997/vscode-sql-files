import { describe, it, expect, vi, beforeEach } from "vitest";
import { readConfig, writeConfig, ConfigReadError } from "../../src/configManager";
import { ConfigTableEntry } from "../../src/types";

// Access the mocked workspace.fs via typed helper
import * as vscode from "vscode";
import { mockWorkspaceFs, type MockWorkspaceFs } from "../helpers/vscode-mock";

describe("configManager — readConfig (workspace.fs interaction)", () => {
    let mockFs: MockWorkspaceFs;

    beforeEach(() => {
        vi.restoreAllMocks();
        mockFs = mockWorkspaceFs();
    });

    it("returns missing=true when file does not exist (FileNotFound)", async () => {
        mockFs.readFile.mockRejectedValue(Object.assign(new Error("File not found"), { code: "FileNotFound" }));

        const root = vscode.Uri.file("/workspace");
        const result = await readConfig(root);
        expect(result.missing).toBe(true);
        expect(result.entries).toEqual([]);
        expect(result.diagnostics).toEqual([]);
    });

    it("returns missing=true for ENOENT errors", async () => {
        mockFs.readFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

        const root = vscode.Uri.file("/workspace");
        const result = await readConfig(root);
        expect(result.missing).toBe(true);
    });

    it("returns missing=true for EntryNotFound (FileSystemError) name", async () => {
        mockFs.readFile.mockRejectedValue(Object.assign(new Error("Not found"), { name: "EntryNotFound (FileSystemError)" }));

        const root = vscode.Uri.file("/workspace");
        const result = await readConfig(root);
        expect(result.missing).toBe(true);
    });

    // Narrowed detection: generic "not found" message without recognized code is NOT treated as missing
    it("throws ConfigReadError for errors with 'not found' in message but no recognized code", async () => {
        mockFs.readFile.mockRejectedValue(new Error("Something not found but not ENOENT"));

        const root = vscode.Uri.file("/workspace");
        await expect(readConfig(root)).rejects.toThrow(ConfigReadError);
    });

    it("throws ConfigReadError for non-FileNotFound errors (permission denied)", async () => {
        mockFs.readFile.mockRejectedValue(Object.assign(new Error("Permission denied"), { code: "EACCES" }));

        const root = vscode.Uri.file("/workspace");
        await expect(readConfig(root)).rejects.toThrow(ConfigReadError);
        try {
            await readConfig(root);
        } catch (err) {
            expect(err).toBeInstanceOf(ConfigReadError);
            expect((err as ConfigReadError).code).toBe("READ_FAILURE");
            expect((err as ConfigReadError).uri.fsPath).toContain(".filesql");
        }
    });

    it("throws ConfigReadError for generic I/O errors", async () => {
        mockFs.readFile.mockRejectedValue(new Error("Disk I/O error"));

        const root = vscode.Uri.file("/workspace");
        await expect(readConfig(root)).rejects.toThrow(ConfigReadError);
    });

    it("returns entries and no diagnostics for valid config", async () => {
        const validConfig = JSON.stringify({
            version: 1,
            tables: [{ name: "t", source: "./data.csv", fileType: "csv" }],
        });
        mockFs.readFile.mockResolvedValue(Buffer.from(validConfig));

        const root = vscode.Uri.file("/workspace");
        const result = await readConfig(root);
        expect(result.missing).toBe(false);
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].name).toBe("t");
        expect(result.diagnostics).toEqual([]);
    });

    it("returns empty entries with diagnostics for malformed config", async () => {
        mockFs.readFile.mockResolvedValue(Buffer.from("not json"));

        const root = vscode.Uri.file("/workspace");
        const result = await readConfig(root);
        expect(result.missing).toBe(false);
        expect(result.entries).toEqual([]);
        expect(result.diagnostics.length).toBeGreaterThan(0);
    });
});

describe("configManager — writeConfig (workspace.fs interaction)", () => {
    let mockFs: MockWorkspaceFs;

    beforeEach(() => {
        vi.restoreAllMocks();
        mockFs = mockWorkspaceFs();
    });

    it("throws when createDirectory fails", async () => {
        mockFs.createDirectory.mockRejectedValue(new Error("Cannot create directory"));

        const root = vscode.Uri.file("/workspace");
        const entries: ConfigTableEntry[] = [{ name: "t", source: "./t.csv", fileType: "csv" }];
        await expect(writeConfig(root, entries)).rejects.toThrow("Cannot create directory");
    });

    it("throws when writing temp file fails", async () => {
        mockFs.writeFile.mockRejectedValue(new Error("Disk full"));

        const root = vscode.Uri.file("/workspace");
        const entries: ConfigTableEntry[] = [{ name: "t", source: "./t.csv", fileType: "csv" }];
        await expect(writeConfig(root, entries)).rejects.toThrow(/temp config file/);
    });

    it("throws when rename fails and cleans up temp best-effort", async () => {
        mockFs.writeFile.mockResolvedValue(undefined);
        mockFs.rename.mockRejectedValue(new Error("Rename not supported"));
        mockFs.delete.mockResolvedValue(undefined);

        const root = vscode.Uri.file("/workspace");
        const entries: ConfigTableEntry[] = [{ name: "t", source: "./t.csv", fileType: "csv" }];
        await expect(writeConfig(root, entries)).rejects.toThrow(/rename temp config/);
        expect(mockFs.delete).toHaveBeenCalled();
    });

    it("rename failure cleanup is best-effort (delete failure swallowed)", async () => {
        mockFs.writeFile.mockResolvedValue(undefined);
        mockFs.rename.mockRejectedValue(new Error("Rename not supported"));
        mockFs.delete.mockRejectedValue(new Error("Cannot delete"));

        const root = vscode.Uri.file("/workspace");
        const entries: ConfigTableEntry[] = [{ name: "t", source: "./t.csv", fileType: "csv" }];
        await expect(writeConfig(root, entries)).rejects.toThrow(/rename temp config/);
    });

    it("uses crypto-random temp file name (not Date.now)", async () => {
        const writtenUris: string[] = [];
        mockFs.writeFile.mockImplementation((uri: { fsPath: string }) => {
            writtenUris.push(uri.fsPath);
            return Promise.resolve();
        });
        mockFs.rename.mockResolvedValue(undefined);

        const root = vscode.Uri.file("/workspace");
        const entries: ConfigTableEntry[] = [{ name: "t", source: "./t.csv", fileType: "csv" }];
        await writeConfig(root, entries);

        expect(writtenUris.length).toBe(1);
        const tmpName = writtenUris[0].split("/").pop()!;
        // Random hex suffix (16 chars = 8 bytes)
        expect(tmpName).toMatch(/^config\.tmp\.[0-9a-f]{16}\.json$/);
    });

    it("writes successfully with temp+rename", async () => {
        const written: { uri: string; data: string }[] = [];
        mockFs.writeFile.mockImplementation((uri: { fsPath: string }, data: Uint8Array) => {
            written.push({ uri: uri.fsPath, data: Buffer.from(data).toString("utf-8") });
            return Promise.resolve();
        });
        mockFs.rename.mockResolvedValue(undefined);

        const root = vscode.Uri.file("/workspace");
        const entries: ConfigTableEntry[] = [
            { name: "t", source: "./t.csv", fileType: "csv" },
        ];
        await writeConfig(root, entries);

        expect(written.length).toBe(1);
        const content = JSON.parse(written[0].data);
        expect(content.version).toBe(1);
        expect(content.tables).toHaveLength(1);
        expect(content.tables[0]).toEqual({ name: "t", source: "./t.csv", fileType: "csv" });
        expect(mockFs.rename).toHaveBeenCalled();
    });

    it("throws validation error for entries with invalid source on write", async () => {
        const root = vscode.Uri.file("/workspace");
        const entries: ConfigTableEntry[] = [
            { name: "t", source: "/absolute/path.csv", fileType: "csv" },
        ];
        await expect(writeConfig(root, entries)).rejects.toThrow(/validation failed/);
    });

    it("throws validation error for duplicate names on write", async () => {
        const root = vscode.Uri.file("/workspace");
        const entries: ConfigTableEntry[] = [
            { name: "t", source: "./a.csv", fileType: "csv" },
            { name: "t", source: "./b.csv", fileType: "csv" },
        ];
        await expect(writeConfig(root, entries)).rejects.toThrow(/validation failed/);
    });

    it("projects only approved fields in output (strips extra properties)", async () => {
        const written: { data: string }[] = [];
        mockFs.writeFile.mockImplementation((_uri: { fsPath: string }, data: Uint8Array) => {
            written.push({ data: Buffer.from(data).toString("utf-8") });
            return Promise.resolve();
        });
        mockFs.rename.mockResolvedValue(undefined);

        const root = vscode.Uri.file("/workspace");
        const entries = [
            { name: "t", source: "./t.csv", fileType: "csv", hivePartitioning: true } as ConfigTableEntry,
        ];
        await writeConfig(root, entries);

        const content = JSON.parse(written[0].data);
        const table = content.tables[0];
        expect(Object.keys(table).sort()).toEqual(["fileType", "hivePartitioning", "name", "source"]);
    });
});

describe("configManager — writeConfig → readConfig round-trip", () => {
    let mockFs: MockWorkspaceFs;

    beforeEach(() => {
        vi.restoreAllMocks();
        mockFs = mockWorkspaceFs();
    });

    it("emitted JSON is accepted by readConfig and entries are equivalent", async () => {
        // Capture what writeConfig writes, then feed it to readConfig
        let writtenBytes: Uint8Array | undefined;
        mockFs.writeFile.mockImplementation((_uri: { fsPath: string }, data: Uint8Array) => {
            writtenBytes = data;
            return Promise.resolve();
        });
        mockFs.rename.mockResolvedValue(undefined);

        const root = vscode.Uri.file("/workspace");
        const original: ConfigTableEntry[] = [
            { name: "sales", source: "./data/sales.csv", fileType: "csv" },
            { name: "events", source: "s3://my-bucket/events/", fileType: "parquet", hivePartitioning: true },
            { name: "logs", source: "./logs/app.json", fileType: "json" },
        ];

        await writeConfig(root, original);
        expect(writtenBytes).toBeDefined();

        // Now use the written bytes as the response for readFile
        mockFs.readFile.mockResolvedValue(writtenBytes!);
        const result = await readConfig(root);

        expect(result.missing).toBe(false);
        expect(result.diagnostics).toEqual([]);
        expect(result.entries).toHaveLength(3);
        expect(result.entries).toEqual(original);
    });

    it("round-trip preserves trimmed values and does not duplicate", async () => {
        let writtenBytes: Uint8Array | undefined;
        mockFs.writeFile.mockImplementation((_uri: { fsPath: string }, data: Uint8Array) => {
            writtenBytes = data;
            return Promise.resolve();
        });
        mockFs.rename.mockResolvedValue(undefined);

        const root = vscode.Uri.file("/workspace");
        // Input with minor whitespace that gets normalized on write
        const original: ConfigTableEntry[] = [
            { name: " padded ", source: " ./data/file.csv ", fileType: "csv" },
        ];

        await writeConfig(root, original);
        expect(writtenBytes).toBeDefined();

        // Verify the JSON output has trimmed values
        const json = JSON.parse(Buffer.from(writtenBytes!).toString("utf-8"));
        expect(json.tables[0].name).toBe("padded");
        expect(json.tables[0].source).toBe("./data/file.csv");

        // Feed back through readConfig
        mockFs.readFile.mockResolvedValue(writtenBytes!);
        const result = await readConfig(root);
        expect(result.diagnostics).toEqual([]);
        expect(result.entries).toEqual([{ name: "padded", source: "./data/file.csv", fileType: "csv" }]);
    });
});
