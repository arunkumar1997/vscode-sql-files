import { describe, it, expect, vi, beforeEach } from "vitest";
import { TableRegistry } from "../../src/tableRegistry";
import { ConfigTableEntry, TableEntry } from "../../src/types";
import { MockMemento } from "../helpers/vscode-mock";

function makeEntry(name: string, overrides?: Partial<TableEntry>): TableEntry {
    return {
        name,
        filePath: `/tmp/${name}.csv`,
        fileType: "csv",
        isS3: false,
        ...overrides,
    };
}

describe("TableRegistry — load states", () => {
    let registry: TableRegistry;
    let changeSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        registry = new TableRegistry();
        changeSpy = vi.fn();
        registry.onDidChange(changeSpy);
    });

    describe("addConfigured", () => {
        it("adds entries with loadState 'configured' and origin 'config'", () => {
            const configs: ConfigTableEntry[] = [
                { name: "sales", source: "./data/sales.csv", fileType: "csv" },
                { name: "events", source: "s3://bucket/events/", fileType: "parquet", hivePartitioning: true },
            ];
            registry.addConfigured(configs);

            const sales = registry.get("sales")!;
            expect(sales.loadState).toBe("configured");
            expect(sales.origin).toBe("config");
            expect(sales.source).toBe("./data/sales.csv");
            expect(sales.filePath).toBe("./data/sales.csv");
            expect(sales.fileType).toBe("csv");
            expect(sales.isS3).toBe(false);
            expect(sales.columns).toBeUndefined();

            const events = registry.get("events")!;
            expect(events.loadState).toBe("configured");
            expect(events.origin).toBe("config");
            expect(events.isS3).toBe(true);
            expect(events.sourceUri).toBe("s3://bucket/events/");
            expect(events.source).toBe("s3://bucket/events/");
            expect(events.hivePartitioning).toBe(true);
        });

        it("fires onDidChange once for batch add", () => {
            const configs: ConfigTableEntry[] = [
                { name: "a", source: "./a.csv", fileType: "csv" },
                { name: "b", source: "./b.csv", fileType: "csv" },
            ];
            registry.addConfigured(configs);
            expect(changeSpy).toHaveBeenCalledTimes(1);
        });

        it("does not fire if no entries were added (all duplicates)", () => {
            registry.add(makeEntry("existing"));
            changeSpy.mockReset();
            registry.addConfigured([{ name: "existing", source: "./x.csv", fileType: "csv" }]);
            expect(changeSpy).not.toHaveBeenCalled();
        });

        it("skips entries whose name already exists (existing wins)", () => {
            registry.add(makeEntry("sales", { filePath: "/original.csv" }));
            registry.addConfigured([{ name: "sales", source: "./override.csv", fileType: "csv" }]);
            expect(registry.get("sales")!.filePath).toBe("/original.csv");
        });

        it("does not fire if input is empty", () => {
            registry.addConfigured([]);
            expect(changeSpy).not.toHaveBeenCalled();
        });

        // CORRECTION 6: Config digest / mutation guard
        it("stores a config digest for mutation detection", () => {
            const configs: ConfigTableEntry[] = [
                { name: "a", source: "./a.csv", fileType: "csv" },
            ];
            registry.addConfigured(configs);
            expect(registry.lastConfigDigest).toBeDefined();
            expect(typeof registry.lastConfigDigest).toBe("string");
        });

        it("isConfigUnchanged returns true for same config", () => {
            const configs: ConfigTableEntry[] = [
                { name: "a", source: "./a.csv", fileType: "csv" },
            ];
            registry.addConfigured(configs);
            expect(registry.isConfigUnchanged(configs)).toBe(true);
        });

        it("isConfigUnchanged returns false for different config", () => {
            const configs: ConfigTableEntry[] = [
                { name: "a", source: "./a.csv", fileType: "csv" },
            ];
            registry.addConfigured(configs);
            const newConfigs: ConfigTableEntry[] = [
                { name: "a", source: "./a.csv", fileType: "csv" },
                { name: "b", source: "./b.csv", fileType: "csv" },
            ];
            expect(registry.isConfigUnchanged(newConfigs)).toBe(false);
        });
    });

    describe("setLoadState", () => {
        it("transitions loadState and fires event", () => {
            registry.addConfigured([{ name: "t", source: "./t.csv", fileType: "csv" }]);
            changeSpy.mockReset();

            registry.setLoadState("t", "loading");
            expect(registry.get("t")!.loadState).toBe("loading");
            expect(changeSpy).toHaveBeenCalledTimes(1);

            registry.setLoadState("t", "loaded");
            expect(registry.get("t")!.loadState).toBe("loaded");
        });

        it("sets loadError on 'error' state and clears on non-error", () => {
            registry.addConfigured([{ name: "t", source: "./t.csv", fileType: "csv" }]);

            registry.setLoadState("t", "error", "File not found");
            expect(registry.get("t")!.loadError).toBe("File not found");

            registry.setLoadState("t", "configured");
            expect(registry.get("t")!.loadError).toBeUndefined();
        });

        it("is a no-op for non-existing tables", () => {
            changeSpy.mockReset();
            registry.setLoadState("ghost", "loaded");
            expect(changeSpy).not.toHaveBeenCalled();
        });
    });

    describe("getLoaded", () => {
        it("returns only loaded tables", () => {
            registry.addConfigured([
                { name: "a", source: "./a.csv", fileType: "csv" },
                { name: "b", source: "./b.csv", fileType: "csv" },
            ]);
            registry.setLoadState("a", "loaded");
            // b stays 'configured'

            const loaded = registry.getLoaded();
            expect(loaded).toHaveLength(1);
            expect(loaded[0].name).toBe("a");
        });

        it("includes entries with undefined loadState (backward compat with ad-hoc adds)", () => {
            registry.add(makeEntry("adhoc")); // no loadState set
            expect(registry.get("adhoc")!.loadState).toBeUndefined();

            const loaded = registry.getLoaded();
            expect(loaded).toHaveLength(1);
            expect(loaded[0].name).toBe("adhoc");
        });

        it("excludes 'configured', 'loading', and 'error' states", () => {
            registry.addConfigured([
                { name: "conf", source: "./c.csv", fileType: "csv" },
                { name: "load", source: "./l.csv", fileType: "csv" },
                { name: "err", source: "./e.csv", fileType: "csv" },
            ]);
            registry.setLoadState("load", "loading");
            registry.setLoadState("err", "error", "oops");

            const loaded = registry.getLoaded();
            expect(loaded).toHaveLength(0);
        });

        it("works correctly with mixed ad-hoc and configured entries", () => {
            registry.add(makeEntry("adhoc1"));
            registry.add(makeEntry("adhoc2", { loadState: "loaded" }));
            registry.addConfigured([
                { name: "cfg1", source: "./c.csv", fileType: "csv" },
            ]);

            const loaded = registry.getLoaded();
            const names = loaded.map((e) => e.name).sort();
            expect(names).toEqual(["adhoc1", "adhoc2"]);
        });
    });

    // CORRECTION 1: Origin tracking and persist-only-adhoc
    describe("origin and persistence", () => {
        it("ad-hoc add() sets origin 'adhoc'", () => {
            registry.add(makeEntry("x"));
            expect(registry.get("x")!.origin).toBe("adhoc");
        });

        it("addConfigured sets origin 'config'", () => {
            registry.addConfigured([{ name: "c", source: "./c.csv", fileType: "csv" }]);
            expect(registry.get("c")!.origin).toBe("config");
        });

        it("persist() only stores adhoc entries in memento", () => {
            const memento = new MockMemento();
            registry.setStorage(memento as unknown as import("vscode").Memento);

            registry.add(makeEntry("adhoc1"));
            registry.addConfigured([{ name: "cfg1", source: "./c.csv", fileType: "csv" }]);

            // Trigger persist by adding another adhoc entry
            registry.add(makeEntry("adhoc2"));

            const persisted = memento.get<TableEntry[]>("fileSql.registeredTables", []);
            expect(persisted).toBeDefined();
            const names = persisted.map((e: TableEntry) => e.name);
            expect(names).toContain("adhoc1");
            expect(names).toContain("adhoc2");
            expect(names).not.toContain("cfg1");
        });

        it("config entries never leak into workspaceState even after setLoadState", () => {
            const memento = new MockMemento();
            registry.setStorage(memento as unknown as import("vscode").Memento);

            registry.addConfigured([{ name: "cfg", source: "./c.csv", fileType: "csv" }]);
            registry.setLoadState("cfg", "loaded");

            const persisted = memento.get<TableEntry[]>("fileSql.registeredTables", []);
            const names = persisted.map((e: TableEntry) => e.name);
            expect(names).not.toContain("cfg");
        });

        it("loadFromStorage restores entries with origin 'adhoc'", () => {
            const memento = new MockMemento();
            memento.update("fileSql.registeredTables", [
                { name: "restored", filePath: "/tmp/r.csv", fileType: "csv", isS3: false },
            ]);
            registry.setStorage(memento as unknown as import("vscode").Memento);
            registry.loadFromStorage();

            expect(registry.get("restored")!.origin).toBe("adhoc");
        });

        it("loadFromStorage filters out entries with origin=config that leaked", () => {
            const memento = new MockMemento();
            memento.update("fileSql.registeredTables", [
                { name: "leaked", filePath: "./x.csv", fileType: "csv", isS3: false, origin: "config", loadState: "configured" },
                { name: "legit", filePath: "/tmp/y.csv", fileType: "csv", isS3: false, origin: "adhoc" },
            ]);
            registry.setStorage(memento as unknown as import("vscode").Memento);
            const restored = registry.loadFromStorage();

            expect(restored).toHaveLength(1);
            expect(restored[0].name).toBe("legit");
            expect(registry.has("leaked")).toBe(false);
        });

        it("loadFromStorage filters out entries with loadState=configured", () => {
            const memento = new MockMemento();
            memento.update("fileSql.registeredTables", [
                { name: "leaked2", filePath: "./z.csv", fileType: "csv", isS3: false, loadState: "configured" },
            ]);
            registry.setStorage(memento as unknown as import("vscode").Memento);
            const restored = registry.loadFromStorage();

            expect(restored).toHaveLength(0);
            expect(registry.has("leaked2")).toBe(false);
        });

        it("loadFromStorage clears transient loading/error states", () => {
            const memento = new MockMemento();
            memento.update("fileSql.registeredTables", [
                { name: "wasLoading", filePath: "/tmp/w.csv", fileType: "csv", isS3: false, loadState: "loading" },
                { name: "wasError", filePath: "/tmp/e.csv", fileType: "csv", isS3: false, loadState: "error", loadError: "fail" },
            ]);
            registry.setStorage(memento as unknown as import("vscode").Memento);
            const restored = registry.loadFromStorage();

            expect(restored).toHaveLength(2);
            expect(registry.get("wasLoading")!.loadState).toBeUndefined();
            expect(registry.get("wasError")!.loadState).toBeUndefined();
        });
    });

    describe("backward compatibility", () => {
        it("ad-hoc add() does not set loadState — remains undefined", () => {
            registry.add(makeEntry("x"));
            expect(registry.get("x")!.loadState).toBeUndefined();
        });

        it("getAll still returns all entries regardless of state", () => {
            registry.add(makeEntry("adhoc"));
            registry.addConfigured([{ name: "cfg", source: "./c.csv", fileType: "csv" }]);
            expect(registry.getAll()).toHaveLength(2);
        });
    });

    describe("runtime identity", () => {
        it("assigns a runtime ID when adding an entry", () => {
            registry.add(makeEntry("t1"));
            const rid = registry.getRuntimeId("t1");
            expect(rid).toBeDefined();
            expect(typeof rid).toBe("string");
            expect(rid!.length).toBeGreaterThan(0);
        });

        it("assigns a runtime ID when adding configured entries", () => {
            registry.addConfigured([{ name: "cfg1", source: "./c.csv", fileType: "csv" }]);
            const rid = registry.getRuntimeId("cfg1");
            expect(rid).toBeDefined();
        });

        it("preserves runtime ID through rename", () => {
            registry.add(makeEntry("old"));
            const ridBefore = registry.getRuntimeId("old");
            registry.rename("old", "new");
            const ridAfter = registry.getRuntimeId("new");
            expect(ridAfter).toBe(ridBefore);
            expect(registry.getRuntimeId("old")).toBeUndefined();
        });

        it("different entries get different runtime IDs", () => {
            registry.add(makeEntry("a"));
            registry.add(makeEntry("b"));
            expect(registry.getRuntimeId("a")).not.toBe(registry.getRuntimeId("b"));
        });

        it("clear removes all runtime IDs", () => {
            registry.add(makeEntry("x"));
            registry.clear();
            expect(registry.getRuntimeId("x")).toBeUndefined();
        });
    });

    describe("rename/remove guards during loading", () => {
        it("blocks rename when entry is in loading state", () => {
            registry.addConfigured([{ name: "t", source: "./t.csv", fileType: "csv" }]);
            registry.setLoadState("t", "loading");

            expect(() => registry.rename("t", "t2")).toThrow(/loading/);
        });

        it("blocks remove when entry is in loading state", () => {
            registry.addConfigured([{ name: "t", source: "./t.csv", fileType: "csv" }]);
            registry.setLoadState("t", "loading");

            expect(() => registry.remove("t")).toThrow(/loading/);
        });

        it("allows rename when entry is loaded", () => {
            registry.addConfigured([{ name: "t", source: "./t.csv", fileType: "csv" }]);
            registry.setLoadState("t", "loaded");

            expect(registry.rename("t", "t2")).toBe(true);
            expect(registry.has("t2")).toBe(true);
        });

        it("allows remove when entry is in error state", () => {
            registry.addConfigured([{ name: "t", source: "./t.csv", fileType: "csv" }]);
            registry.setLoadState("t", "error", "oops");

            expect(registry.remove("t")).toBe(true);
        });

        it("allows remove when entry is configured", () => {
            registry.addConfigured([{ name: "t", source: "./t.csv", fileType: "csv" }]);

            expect(registry.remove("t")).toBe(true);
        });
    });

    describe("source immutability", () => {
        it("source field on config entries is not writable", () => {
            registry.addConfigured([{ name: "t", source: "./original.csv", fileType: "csv" }]);
            const entry = registry.get("t")!;

            // Attempt to mutate — should be silently ignored in strict mode or throw
            expect(() => { entry.source = "./hacked.csv"; }).toThrow();
            expect(entry.source).toBe("./original.csv");
        });
    });

    describe("reconcileConfig", () => {
        it("adds new entries", () => {
            const result = registry.reconcileConfig([
                { name: "a", source: "./a.csv", fileType: "csv" },
            ]);
            expect(result.added).toContain("a");
            expect(registry.get("a")!.loadState).toBe("configured");
        });

        it("updates changed config entry in configured state", () => {
            registry.addConfigured([
                { name: "a", source: "./old.csv", fileType: "csv" },
            ]);
            const result = registry.reconcileConfig([
                { name: "a", source: "./new.csv", fileType: "csv" },
            ]);
            expect(result.updated).toContain("a");
            expect(registry.get("a")!.filePath).toBe("./new.csv");
        });

        it("removes config entry no longer in new config (configured state)", () => {
            registry.addConfigured([
                { name: "a", source: "./a.csv", fileType: "csv" },
                { name: "b", source: "./b.csv", fileType: "csv" },
            ]);
            const result = registry.reconcileConfig([
                { name: "a", source: "./a.csv", fileType: "csv" },
            ]);
            expect(result.removed).toContain("b");
            expect(registry.get("b")).toBeUndefined();
        });

        it("preserves loaded table (does not remove or update)", () => {
            registry.addConfigured([
                { name: "a", source: "./a.csv", fileType: "csv" },
            ]);
            registry.setLoadState("a", "loaded");

            const result = registry.reconcileConfig([]);
            expect(result.skipped).toContain("a");
            expect(registry.get("a")).toBeDefined();
            expect(registry.get("a")!.loadState).toBe("loaded");
        });

        it("preserves ad-hoc entries with same name", () => {
            registry.add(makeEntry("a"));
            const result = registry.reconcileConfig([
                { name: "a", source: "./a.csv", fileType: "csv" },
            ]);
            expect(result.skipped).toContain("a");
            expect(registry.get("a")!.origin).toBe("adhoc");
        });

        it("idempotent re-import does not duplicate", () => {
            registry.reconcileConfig([
                { name: "a", source: "./a.csv", fileType: "csv" },
            ]);
            const result = registry.reconcileConfig([
                { name: "a", source: "./a.csv", fileType: "csv" },
            ]);
            expect(result.added).toHaveLength(0);
            expect(result.updated).toHaveLength(0);
            expect(registry.getAll().filter(e => e.name === "a")).toHaveLength(1);
        });
    });
});
