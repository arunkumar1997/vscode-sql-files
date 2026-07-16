import { describe, it, expect, vi, beforeEach } from "vitest";
import { sanitizeQueryBaseName, writeSavedQueries } from "../../src/configManager";
import { SavedQuery } from "../../src/types";

vi.mock("vscode", () => import("../helpers/vscode-mock"));

import * as vscode from "vscode";
import { mockWorkspaceFs, type MockWorkspaceFs } from "../helpers/vscode-mock";

describe("managed queries — sanitizeQueryBaseName", () => {
    it("basic name", () => {
        expect(sanitizeQueryBaseName("my query", 0)).toBe("my query");
    });

    it("strips .sql suffix", () => {
        expect(sanitizeQueryBaseName("report.sql", 0)).toBe("report");
    });

    it("replaces invalid characters with hyphen", () => {
        expect(sanitizeQueryBaseName("file/name:test", 0)).toBe("file-name-test");
    });

    it("collapses consecutive hyphens", () => {
        expect(sanitizeQueryBaseName("a///b", 0)).toBe("a-b");
    });

    it("falls back to query-N for empty result", () => {
        expect(sanitizeQueryBaseName("///", 2)).toBe("query-3");
    });

    it("caps length", () => {
        const long = "a".repeat(200);
        expect(sanitizeQueryBaseName(long, 0).length).toBeLessThanOrEqual(100);
    });
});

describe("managed queries — writeSavedQueries", () => {
    let mockFs: MockWorkspaceFs;
    const root = vscode.Uri.file("/workspace");

    beforeEach(() => {
        vi.restoreAllMocks();
        mockFs = mockWorkspaceFs();
    });

    it("writes zero query files when queries is empty (no stale deletion)", async () => {
        // No manifest exists
        mockFs.readFile.mockRejectedValue(Object.assign(new Error("Not found"), { code: "FileNotFound" }));
        mockFs.readDirectory.mockRejectedValue(Object.assign(new Error("Not found"), { code: "FileNotFound" }));

        await writeSavedQueries(root, []);

        // Should write manifest with empty files
        const renameCalls = mockFs.rename.mock.calls;
        // Manifest rename is the only rename (no query files written)
        expect(renameCalls.length).toBe(1);
        expect(renameCalls[0][1].path).toContain(".filesql-managed.json");
    });

    it("writes managed queries and manifest", async () => {
        mockFs.readFile.mockRejectedValue(Object.assign(new Error("Not found"), { code: "FileNotFound" }));
        mockFs.readDirectory.mockResolvedValue([]);

        const queries: SavedQuery[] = [
            { name: "report", sql: "SELECT 1" },
            { name: "analysis", sql: "SELECT 2" },
        ];

        await writeSavedQueries(root, queries);

        // Should have 3 renames: 2 query files + 1 manifest
        expect(mockFs.rename.mock.calls.length).toBe(3);
        const manifestWrite = mockFs.writeFile.mock.calls.find(
            (call: [{ path: string }, Buffer]) =>
                call[0].path.includes(".filesql-managed.tmp."),
        );
        expect(JSON.parse(manifestWrite![1].toString())).toMatchObject({
            files: ["report.sql", "analysis.sql"],
            queries: [
                { name: "report", file: "report.sql" },
                { name: "analysis", file: "analysis.sql" },
            ],
        });
    });

    it("preserves unmanaged SQL file (does not delete)", async () => {
        // Previous manifest lists "old-managed.sql"
        const manifestJson = JSON.stringify({ files: ["old-managed.sql"] });
        mockFs.readFile.mockResolvedValue(Buffer.from(manifestJson));
        // Disk has old-managed.sql and user-created.sql
        mockFs.readDirectory.mockResolvedValue([
            ["old-managed.sql", 1], // FileType.File
            ["user-created.sql", 1],
        ]);

        const queries: SavedQuery[] = [
            { name: "new-query", sql: "SELECT 1" },
        ];

        await writeSavedQueries(root, queries);

        // Should delete old-managed.sql (stale managed)
        const deleteCalls = mockFs.delete.mock.calls;
        const deletedPaths = deleteCalls.map((c: [{ path: string }]) => c[0].path);
        expect(deletedPaths.some((p: string) => p.includes("old-managed.sql"))).toBe(true);
        // Should NOT delete user-created.sql
        expect(deletedPaths.some((p: string) => p.includes("user-created.sql"))).toBe(false);
    });

    it("does not overwrite unmanaged file with same name (uses suffix)", async () => {
        mockFs.readFile.mockRejectedValue(Object.assign(new Error("Not found"), { code: "FileNotFound" }));
        // Disk has "report.sql" that is unmanaged
        mockFs.readDirectory.mockResolvedValue([
            ["report.sql", 1],
        ]);

        const queries: SavedQuery[] = [
            { name: "report", sql: "SELECT 1" },
        ];

        await writeSavedQueries(root, queries);

        // Should write to report-2.sql (suffixed) not report.sql
        const renameCalls = mockFs.rename.mock.calls;
        const queryRename = renameCalls.find(
            (c: [{ path: string }, { path: string }]) => c[1].path.endsWith(".sql") && !c[1].path.includes("filesql-managed")
        );
        expect(queryRename).toBeDefined();
        expect(queryRename![1].path).toContain("report-2.sql");
    });

    it("handles missing manifest conservatively (treats all existing as unmanaged)", async () => {
        mockFs.readFile.mockRejectedValue(Object.assign(new Error("Not found"), { code: "FileNotFound" }));
        mockFs.readDirectory.mockResolvedValue([
            ["existing.sql", 1],
        ]);

        const queries: SavedQuery[] = [
            { name: "existing", sql: "SELECT 1" },
        ];

        await writeSavedQueries(root, queries);

        // Should NOT delete existing.sql (no manifest means all unmanaged)
        const deleteCalls = mockFs.delete.mock.calls;
        const deletedPaths = deleteCalls.map((c: [{ path: string }]) => c[0].path);
        expect(deletedPaths.some((p: string) => p.includes("existing.sql"))).toBe(false);

        // Should use suffixed name
        const renameCalls = mockFs.rename.mock.calls;
        const queryRename = renameCalls.find(
            (c: [{ path: string }, { path: string }]) => c[1].path.endsWith(".sql") && !c[1].path.includes("filesql-managed")
        );
        expect(queryRename![1].path).toContain("existing-2.sql");
    });

    it("handles corrupt manifest conservatively", async () => {
        mockFs.readFile.mockResolvedValue(Buffer.from("not json at all {{{"));
        mockFs.readDirectory.mockResolvedValue([
            ["old.sql", 1],
        ]);

        const queries: SavedQuery[] = [
            { name: "new", sql: "SELECT 1" },
        ];

        await writeSavedQueries(root, queries);

        // old.sql treated as unmanaged — not deleted
        const deleteCalls = mockFs.delete.mock.calls;
        const deletedPaths = deleteCalls.map((c: [{ path: string }]) => c[0].path);
        expect(deletedPaths.some((p: string) => p.includes("old.sql"))).toBe(false);
    });

    it("case-insensitive collision avoidance for unmanaged files", async () => {
        mockFs.readFile.mockRejectedValue(Object.assign(new Error("Not found"), { code: "FileNotFound" }));
        mockFs.readDirectory.mockResolvedValue([
            ["Report.sql", 1], // uppercase — unmanaged
        ]);

        const queries: SavedQuery[] = [
            { name: "report", sql: "SELECT 1" }, // lowercase
        ];

        await writeSavedQueries(root, queries);

        // Should use suffixed name since "report.sql" collides with "Report.sql" case-insensitively
        const renameCalls = mockFs.rename.mock.calls;
        const queryRename = renameCalls.find(
            (c: [{ path: string }, { path: string }]) => c[1].path.endsWith(".sql") && !c[1].path.includes("filesql-managed")
        );
        expect(queryRename![1].path).toContain("report-2.sql");
    });

    it("partial write failure does not advance manifest or delete old files", async () => {
        const manifestJson = JSON.stringify({ files: ["old.sql"] });
        // First readFile returns manifest, subsequent calls for other purposes
        mockFs.readFile.mockResolvedValue(Buffer.from(manifestJson));
        mockFs.readDirectory.mockResolvedValue([
            ["old.sql", 1],
        ]);

        // Make the writeFile (staging) succeed but rename (promotion) fail
        mockFs.writeFile.mockResolvedValue(undefined);
        mockFs.rename.mockRejectedValueOnce(new Error("rename failed"));

        const queries: SavedQuery[] = [
            { name: "new-query", sql: "SELECT 1" },
        ];

        await expect(writeSavedQueries(root, queries)).rejects.toThrow("Failed to promote query files");

        // old.sql should NOT be deleted
        const deleteCalls = mockFs.delete.mock.calls;
        const deletedPaths = deleteCalls.map((c: [{ path: string }]) => c[0].path);
        expect(deletedPaths.some((p: string) => p.includes("old.sql"))).toBe(false);
    });

    it("non-SQL files are preserved and not managed", async () => {
        mockFs.readFile.mockRejectedValue(Object.assign(new Error("Not found"), { code: "FileNotFound" }));
        mockFs.readDirectory.mockResolvedValue([
            ["notes.txt", 1],
            ["readme.md", 1],
        ]);

        const queries: SavedQuery[] = [
            { name: "test", sql: "SELECT 1" },
        ];

        await writeSavedQueries(root, queries);

        // Non-SQL files not deleted
        const deleteCalls = mockFs.delete.mock.calls;
        expect(deleteCalls.length).toBe(0);
    });

    it("second staging write fails — no finals touched, temps cleaned", async () => {
        // Existing managed query
        const manifestJson = JSON.stringify({ files: ["existing.sql"] });
        mockFs.readFile.mockResolvedValue(Buffer.from(manifestJson));
        mockFs.readDirectory.mockResolvedValue([["existing.sql", 1]]);

        // First writeFile (staging) succeeds, second fails
        let writeCount = 0;
        mockFs.writeFile.mockImplementation(async () => {
            writeCount++;
            if (writeCount === 2) throw new Error("disk full");
        });

        const queries: SavedQuery[] = [
            { name: "existing", sql: "SELECT updated" }, // edit of existing
            { name: "new-one", sql: "SELECT 2" },       // second write fails
        ];

        await expect(writeSavedQueries(root, queries)).rejects.toThrow("Failed to stage query files");

        // No renames should have been called (staging failed before promotion)
        expect(mockFs.rename).not.toHaveBeenCalled();
        // The final "existing.sql" must not be directly deleted (only temps cleaned)
        const deletedPaths = mockFs.delete.mock.calls.map((c: [{ path: string }]) => c[0].path);
        // Only .staging. temp files should be deleted, not the actual final managed file
        const nonTempDeletions = deletedPaths.filter((p: string) => !p.includes(".staging."));
        expect(nonTempDeletions.length).toBe(0);
        // Temps for first staged file cleaned up
        expect(mockFs.delete.mock.calls.length).toBeGreaterThanOrEqual(1);
        expect(deletedPaths.some((p: string) => p.includes(".staging."))).toBe(true);
    });

    it("promotion/rename fails mid-batch — remaining temps cleaned, old files preserved", async () => {
        const manifestJson = JSON.stringify({ files: ["old-a.sql", "old-b.sql"] });
        mockFs.readFile.mockResolvedValue(Buffer.from(manifestJson));
        mockFs.readDirectory.mockResolvedValue([["old-a.sql", 1], ["old-b.sql", 1]]);
        mockFs.writeFile.mockResolvedValue(undefined);

        // First rename succeeds, second fails
        let renameCount = 0;
        mockFs.rename.mockImplementation(async () => {
            renameCount++;
            if (renameCount === 2) throw new Error("rename exploded");
        });

        const queries: SavedQuery[] = [
            { name: "alpha", sql: "SELECT a" },
            { name: "beta", sql: "SELECT b" },
        ];

        await expect(writeSavedQueries(root, queries)).rejects.toThrow("Failed to promote query files");

        // old-a.sql and old-b.sql should NOT be deleted
        const deletedPaths = mockFs.delete.mock.calls.map((c: [{ path: string }]) => c[0].path);
        expect(deletedPaths.some((p: string) => p.includes("old-a.sql"))).toBe(false);
        expect(deletedPaths.some((p: string) => p.includes("old-b.sql"))).toBe(false);
        // Remaining temp (the one that failed to rename) is cleaned
        expect(deletedPaths.some((p: string) => p.includes(".staging."))).toBe(true);
    });

    it("manifest write fails — query files promoted but manifest unchanged", async () => {
        const oldManifest = JSON.stringify({ files: ["prev.sql"] });
        mockFs.readFile.mockResolvedValue(Buffer.from(oldManifest));
        mockFs.readDirectory.mockResolvedValue([["prev.sql", 1]]);
        mockFs.writeFile.mockResolvedValue(undefined);

        // Promotion renames succeed, but manifest rename fails
        let renameCount = 0;
        mockFs.rename.mockImplementation(async () => {
            renameCount++;
            // Query promotion renames succeed (1 query = 1 rename)
            // Manifest rename is the second rename call — make it fail
            if (renameCount === 2) throw new Error("manifest rename failed");
        });

        const queries: SavedQuery[] = [
            { name: "updated", sql: "SELECT new" },
        ];

        await expect(writeSavedQueries(root, queries)).rejects.toThrow();

        // prev.sql should NOT be deleted (stale deletion only runs after manifest commit)
        const deletedPaths = mockFs.delete.mock.calls.map((c: [{ path: string }]) => c[0].path);
        expect(deletedPaths.some((p: string) => p.includes("prev.sql"))).toBe(false);
    });
});
