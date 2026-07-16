import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { TableRegistry } from "../../src/tableRegistry";
import { SqlCompletionProvider } from "../../src/providers/completionProvider";
import { TablesTreeProvider } from "../../src/providers/tablesTreeProvider";
import { ConfigTableEntry, TableEntry } from "../../src/types";

vi.mock("vscode", () => import("../helpers/vscode-mock"));

describe("Integration — activation config restore (Slice 7)", () => {
    let registry: TableRegistry;

    beforeEach(() => {
        registry = new TableRegistry();
    });

    afterEach(() => {
        registry.dispose();
    });

    it("configured entries appear in registry without DuckDB init", () => {
        const configs: ConfigTableEntry[] = [
            { name: "sales", source: "./data/sales.csv", fileType: "csv" },
            { name: "events", source: "s3://bucket/events/", fileType: "parquet", hivePartitioning: true },
        ];
        registry.addConfigured(configs);

        expect(registry.getAll()).toHaveLength(2);
        expect(registry.get("sales")!.loadState).toBe("configured");
        expect(registry.get("events")!.loadState).toBe("configured");
    });

    it("configured entries are NOT persisted to memento", () => {
        const mockMemento = {
            get: vi.fn().mockReturnValue([]),
            update: vi.fn().mockResolvedValue(undefined),
        };
        registry.setStorage(mockMemento as never);

        const configs: ConfigTableEntry[] = [
            { name: "sales", source: "./data/sales.csv", fileType: "csv" },
        ];
        registry.addConfigured(configs);

        // persist() is called only for adhoc entries — config entries never go to memento
        // After addConfigured, memento.update should NOT have been called with config entries
        const updateCalls = mockMemento.update.mock.calls;
        for (const call of updateCalls) {
            const entries = call[1] as TableEntry[];
            for (const e of entries) {
                expect(e.origin).not.toBe("config");
                expect(e.loadState).not.toBe("configured");
            }
        }
    });

    it("memento-restored entries win over config entries with same name", () => {
        // Simulate memento-restored entry already present
        const adhocEntry: TableEntry = {
            name: "sales",
            filePath: "/absolute/path/to/sales.csv",
            fileType: "csv",
            isS3: false,
            columns: [{ name: "id", type: "INTEGER" }],
            origin: "adhoc",
        };
        registry.add(adhocEntry);

        // Now load config with same name
        const configs: ConfigTableEntry[] = [
            { name: "sales", source: "./data/sales.csv", fileType: "csv" },
        ];
        registry.addConfigured(configs);

        // The memento entry should still be there, not replaced
        const entry = registry.get("sales")!;
        expect(entry.origin).toBe("adhoc");
        expect(entry.filePath).toBe("/absolute/path/to/sales.csv");
        expect(entry.columns).toHaveLength(1);
    });

    it("loadFromStorage does not restore config-origin entries", () => {
        const mockMemento = {
            get: vi.fn().mockReturnValue([
                { name: "leaked", filePath: "./x.csv", fileType: "csv", isS3: false, origin: "config", loadState: "configured" },
                { name: "good", filePath: "/abs/y.csv", fileType: "csv", isS3: false, origin: "adhoc" },
            ]),
            update: vi.fn().mockResolvedValue(undefined),
        };
        registry.setStorage(mockMemento as never);
        const restored = registry.loadFromStorage();

        expect(restored).toHaveLength(1);
        expect(restored[0].name).toBe("good");
        expect(registry.has("leaked")).toBe(false);
    });
});

describe("Integration — completion gating (Slice 6)", () => {
    let registry: TableRegistry;

    beforeEach(() => {
        registry = new TableRegistry();
    });

    afterEach(() => {
        registry.dispose();
    });

    it("configured (unloaded) tables do NOT appear in completions", () => {
        const configs: ConfigTableEntry[] = [
            { name: "sales", source: "./data/sales.csv", fileType: "csv" },
        ];
        registry.addConfigured(configs);

        const provider = new SqlCompletionProvider(registry);
        const items = provider.provideCompletionItems(
            {} as never,
            {} as never,
        );
        const labels = items.map((i) => i.label);
        expect(labels).not.toContain("sales");
    });

    it("loaded tables DO appear in completions", () => {
        const entry: TableEntry = {
            name: "sales",
            filePath: "/tmp/sales.csv",
            fileType: "csv",
            isS3: false,
            loadState: "loaded",
            origin: "config",
            columns: [{ name: "id", type: "INTEGER" }],
        };
        registry.add(entry);

        const provider = new SqlCompletionProvider(registry);
        const items = provider.provideCompletionItems({} as never, {} as never);
        const labels = items.map((i) => i.label);
        expect(labels).toContain("sales");
        expect(labels).toContain("id");
    });

    it("ad-hoc tables (no explicit loadState) appear in completions", () => {
        const entry: TableEntry = {
            name: "adhoc_table",
            filePath: "/tmp/adhoc.csv",
            fileType: "csv",
            isS3: false,
            // loadState undefined — backward compat means loaded
        };
        registry.add(entry);

        const provider = new SqlCompletionProvider(registry);
        const items = provider.provideCompletionItems({} as never, {} as never);
        const labels = items.map((i) => i.label);
        expect(labels).toContain("adhoc_table");
    });

    it("error-state tables do NOT appear in completions", () => {
        const configs: ConfigTableEntry[] = [
            { name: "broken", source: "./data/broken.csv", fileType: "csv" },
        ];
        registry.addConfigured(configs);
        registry.setLoadState("broken", "error", "file not found");

        const provider = new SqlCompletionProvider(registry);
        const items = provider.provideCompletionItems({} as never, {} as never);
        const labels = items.map((i) => i.label);
        expect(labels).not.toContain("broken");
    });

    it("unloading a loaded table removes it from completions", () => {
        const entry: TableEntry = {
            name: "sales",
            filePath: "/tmp/sales.csv",
            fileType: "csv",
            isS3: false,
            loadState: "loaded",
            origin: "config",
            columns: [{ name: "id", type: "INTEGER" }],
        };
        registry.add(entry);

        const provider = new SqlCompletionProvider(registry);

        // Initially has completions
        let items = provider.provideCompletionItems({} as never, {} as never);
        expect(items.map((i) => i.label)).toContain("sales");

        // Unload: transition to configured
        registry.setLoadState("sales", "configured");

        // Now completions exclude it
        items = provider.provideCompletionItems({} as never, {} as never);
        expect(items.map((i) => i.label)).not.toContain("sales");
    });
});

describe("Integration — tree view states (Slice 5)", () => {
    let registry: TableRegistry;
    let treeProvider: TablesTreeProvider;

    beforeEach(() => {
        registry = new TableRegistry();
        treeProvider = new TablesTreeProvider(registry);
    });

    afterEach(() => {
        treeProvider.dispose();
        registry.dispose();
    });

    it("configured entry shows 'Not loaded' description and non-expandable", () => {
        const configs: ConfigTableEntry[] = [
            { name: "sales", source: "./data/sales.csv", fileType: "csv" },
        ];
        registry.addConfigured(configs);

        const nodes = treeProvider.getChildren();
        expect(nodes).toHaveLength(1);
        const node = nodes[0];
        expect(node.description).toBe("Not loaded");
        expect(node.contextValue).toBe("table.configured");
        // Not expandable (None = 0)
        expect(node.collapsibleState).toBe(0);
    });

    it("loaded entry shows fileType description and is expandable", () => {
        const entry: TableEntry = {
            name: "sales",
            filePath: "/tmp/sales.csv",
            fileType: "csv",
            isS3: false,
            loadState: "loaded",
            columns: [{ name: "id", type: "INTEGER" }],
        };
        registry.add(entry);

        const nodes = treeProvider.getChildren();
        expect(nodes).toHaveLength(1);
        const node = nodes[0];
        expect(node.description).toBe("csv");
        expect(node.contextValue).toBe("table");
        // Collapsed = 1
        expect(node.collapsibleState).toBe(1);
    });

    it("error-state entry shows 'Error' and error contextValue", () => {
        const configs: ConfigTableEntry[] = [
            { name: "broken", source: "./bad.csv", fileType: "csv" },
        ];
        registry.addConfigured(configs);
        registry.setLoadState("broken", "error", "File not found");

        const nodes = treeProvider.getChildren();
        const node = nodes[0];
        expect(node.description).toBe("Error");
        expect(node.contextValue).toBe("table.error");
        expect(node.tooltip).toBe("File not found");
    });

    it("loading-state entry shows 'Loading…'", () => {
        const configs: ConfigTableEntry[] = [
            { name: "sales", source: "./data/sales.csv", fileType: "csv" },
        ];
        registry.addConfigured(configs);
        registry.setLoadState("sales", "loading");

        const nodes = treeProvider.getChildren();
        const node = nodes[0];
        expect(node.description).toBe("Loading…");
        expect(node.contextValue).toBe("table.loading");
    });

    it("ad-hoc entry (undefined loadState) shows normally", () => {
        const entry: TableEntry = {
            name: "adhoc",
            filePath: "/tmp/adhoc.csv",
            fileType: "csv",
            isS3: false,
            // no loadState — backward compat
        };
        registry.add(entry);

        const nodes = treeProvider.getChildren();
        const node = nodes[0];
        expect(node.description).toBe("csv");
        expect(node.contextValue).toBe("table");
        expect(node.collapsibleState).toBe(1);
    });
});

describe("Integration — lazy-loading menu contributions", () => {
    it("exposes load and reload actions without an unload action", () => {
        const manifest = JSON.parse(
            fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"),
        );
        const titleMenus = manifest.contributes.menus["view/title"];
        const itemMenus = manifest.contributes.menus["view/item/context"];

        expect(titleMenus).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ command: "fileSql.importWorkspaceConfig" }),
                expect.objectContaining({ command: "fileSql.saveWorkspaceConfig" }),
            ]),
        );
        expect(titleMenus).not.toEqual(
            expect.arrayContaining([
                expect.objectContaining({ command: "fileSql.loadAllTables" }),
            ]),
        );
        expect(itemMenus).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    command: "fileSql.loadTable",
                    when: expect.stringContaining("table.configured"),
                }),
                expect.objectContaining({
                    command: "fileSql.reloadTable",
                    when: "view == fileSqlTables && viewItem == table",
                }),
            ]),
        );
        expect(itemMenus).not.toEqual(
            expect.arrayContaining([
                expect.objectContaining({ command: "fileSql.unloadTable" }),
            ]),
        );
    });
});
