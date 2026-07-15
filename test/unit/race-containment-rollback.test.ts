import { describe, it, expect, vi, beforeEach } from "vitest";
import { TableRegistry } from "../../src/tableRegistry";
import { TableEntry } from "../../src/types";
import * as path from "path";

// Mock vscode before importing module under test
vi.mock("vscode", () => import("../helpers/vscode-mock"));

describe("TableRegistry — add rejects replacing a loading entry", () => {
    let registry: TableRegistry;

    beforeEach(() => {
        registry = new TableRegistry();
    });

    it("throws when trying to add over a loading entry", () => {
        registry.addConfigured([
            { name: "t", source: "./data.csv", fileType: "csv" },
        ]);
        registry.setLoadState("t", "loading");

        const replacement: TableEntry = {
            name: "t",
            filePath: "/other.csv",
            fileType: "csv",
            isS3: false,
        };

        expect(() => registry.add(replacement)).toThrow(/loading/);
        // Original entry is preserved
        expect(registry.get("t")!.filePath).toBe("./data.csv");
    });

    it("allows replacing a loaded entry", () => {
        registry.addConfigured([
            { name: "t", source: "./data.csv", fileType: "csv" },
        ]);
        registry.setLoadState("t", "loaded");

        const replacement: TableEntry = {
            name: "t",
            filePath: "/other.csv",
            fileType: "csv",
            isS3: false,
        };

        expect(() => registry.add(replacement)).not.toThrow();
        expect(registry.get("t")!.filePath).toBe("/other.csv");
    });

    it("allows adding a new entry (no existing)", () => {
        const entry: TableEntry = {
            name: "new",
            filePath: "/new.csv",
            fileType: "csv",
            isS3: false,
        };

        expect(() => registry.add(entry)).not.toThrow();
        expect(registry.get("new")!.filePath).toBe("/new.csv");
    });

    it("allows replacing an error entry", () => {
        registry.addConfigured([
            { name: "t", source: "./data.csv", fileType: "csv" },
        ]);
        registry.setLoadState("t", "error", "some error");

        const replacement: TableEntry = {
            name: "t",
            filePath: "/fixed.csv",
            fileType: "csv",
            isS3: false,
        };

        expect(() => registry.add(replacement)).not.toThrow();
        expect(registry.get("t")!.filePath).toBe("/fixed.csv");
    });
});

describe("TableRegistry — remove/clear guards for loading entries", () => {
    let registry: TableRegistry;

    beforeEach(() => {
        registry = new TableRegistry();
    });

    it("remove throws for loading entry", () => {
        registry.addConfigured([
            { name: "t", source: "./data.csv", fileType: "csv" },
        ]);
        registry.setLoadState("t", "loading");

        expect(() => registry.remove("t")).toThrow(/loading/);
        expect(registry.has("t")).toBe(true);
    });

    it("clear throws if any entry is loading", () => {
        registry.addConfigured([
            { name: "a", source: "./a.csv", fileType: "csv" },
            { name: "b", source: "./b.csv", fileType: "csv" },
        ]);
        registry.setLoadState("a", "loaded");
        registry.setLoadState("b", "loading");

        expect(() => registry.clear()).toThrow(/loading/);
        expect(registry.getAll()).toHaveLength(2);
    });

    it("rename throws for loading entry", () => {
        registry.addConfigured([
            { name: "t", source: "./data.csv", fileType: "csv" },
        ]);
        registry.setLoadState("t", "loading");

        expect(() => registry.rename("t", "t2")).toThrow(/loading/);
        expect(registry.has("t")).toBe(true);
        expect(registry.has("t2")).toBe(false);
    });
});

describe("S3 — path containment validation", () => {
    it("assertContainedPath rejects traversal keys", async () => {
        // Import the module to test the function through public API
        const { downloadS3HiveFolder } = await import("../../src/s3Handler");

        // Mock vscode progress
        const progress = { report: vi.fn() };

        // A key with .. traversal should be rejected
        await expect(
            downloadS3HiveFolder(
                "bucket",
                "prefix/",
                ["prefix/../../../etc/passwd"],
                { keyId: "k", secret: "s" },
                "us-east-1",
                progress,
                "csv",
                ".csv",
                false,
            ),
        ).rejects.toThrow(/Invalid object key|path traversal/i);
    });
});

describe("S3 — createPerLoadTempDir uses random IDs only", () => {
    it("temp dir name does not contain user-controlled strings", async () => {
        // Import the actual function
        const s3Handler = await import("../../src/s3Handler");

        // createPerLoadTempDir() no longer accepts tableName parameter
        // Verify the function signature accepts 0 args
        expect(s3Handler.createPerLoadTempDir.length).toBe(0);

        // Create a temp dir and verify the name pattern
        const tempDir = s3Handler.createPerLoadTempDir();
        const basename = path.basename(tempDir);

        // Should start with "load-" followed by random chars
        expect(basename).toMatch(/^load-/);
        // Should NOT contain potentially dangerous chars
        expect(basename).not.toContain("..");
        expect(basename).not.toContain("/");

        // Cleanup
        s3Handler.cleanupPerLoadTempDir(tempDir);
    });
});
