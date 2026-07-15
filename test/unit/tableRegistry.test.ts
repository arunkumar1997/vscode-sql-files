import { describe, it, expect, vi, beforeEach } from "vitest";
import { TableRegistry } from "../../src/tableRegistry";
import { TableEntry } from "../../src/types";
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

describe("TableRegistry", () => {
  let registry: TableRegistry;
  let changeSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registry = new TableRegistry();
    changeSpy = vi.fn();
    registry.onDidChange(changeSpy);
  });

  describe("add", () => {
    it("adds an entry that can be retrieved by name", () => {
      registry.add(makeEntry("sales"));
      expect(registry.get("sales")).toBeDefined();
      expect(registry.get("sales")!.name).toBe("sales");
    });

    it("fires onDidChange exactly once", () => {
      registry.add(makeEntry("orders"));
      expect(changeSpy).toHaveBeenCalledTimes(1);
    });

    it("overwrites an existing entry with the same name", () => {
      registry.add(makeEntry("dup", { filePath: "/a.csv" }));
      registry.add(makeEntry("dup", { filePath: "/b.csv" }));
      expect(registry.get("dup")!.filePath).toBe("/b.csv");
    });
  });

  describe("remove", () => {
    it("removes an existing entry and returns true", () => {
      registry.add(makeEntry("sales"));
      const removed = registry.remove("sales");
      expect(removed).toBe(true);
      expect(registry.has("sales")).toBe(false);
    });

    it("returns false and does not fire event for missing name", () => {
      changeSpy.mockReset();
      const removed = registry.remove("nonexistent");
      expect(removed).toBe(false);
      expect(changeSpy).not.toHaveBeenCalled();
    });

    it("fires onDidChange exactly once on successful removal", () => {
      registry.add(makeEntry("x"));
      changeSpy.mockReset();
      registry.remove("x");
      expect(changeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("has", () => {
    it("returns true for existing entries", () => {
      registry.add(makeEntry("sales"));
      expect(registry.has("sales")).toBe(true);
    });

    it("returns false for non-existing entries", () => {
      expect(registry.has("nope")).toBe(false);
    });
  });

  describe("get / getAll", () => {
    it("get returns undefined for missing entries", () => {
      expect(registry.get("missing")).toBeUndefined();
    });

    it("getAll returns all registered entries", () => {
      registry.add(makeEntry("a"));
      registry.add(makeEntry("b"));
      const all = registry.getAll();
      expect(all).toHaveLength(2);
      expect(all.map((e) => e.name).sort()).toEqual(["a", "b"]);
    });
  });

  describe("clear", () => {
    it("removes all entries", () => {
      registry.add(makeEntry("a"));
      registry.add(makeEntry("b"));
      registry.clear();
      expect(registry.getAll()).toHaveLength(0);
    });

    it("fires onDidChange exactly once", () => {
      registry.add(makeEntry("a"));
      changeSpy.mockReset();
      registry.clear();
      expect(changeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("rename", () => {
    it("renames an existing entry", () => {
      registry.add(makeEntry("old_name"));
      const result = registry.rename("old_name", "new_name");
      expect(result).toBe(true);
      expect(registry.has("old_name")).toBe(false);
      expect(registry.has("new_name")).toBe(true);
      expect(registry.get("new_name")!.name).toBe("new_name");
    });

    it("returns false when source does not exist", () => {
      changeSpy.mockReset();
      const result = registry.rename("ghost", "something");
      expect(result).toBe(false);
      expect(changeSpy).not.toHaveBeenCalled();
    });

    it("fires onDidChange exactly once on success", () => {
      registry.add(makeEntry("x"));
      changeSpy.mockReset();
      registry.rename("x", "y");
      expect(changeSpy).toHaveBeenCalledTimes(1);
    });

    it("throws when newName already exists", () => {
      registry.add(makeEntry("a", { filePath: "/a.csv" }));
      registry.add(makeEntry("b", { filePath: "/b.csv" }));
      expect(() => registry.rename("a", "b")).toThrow(/already exists/);
    });

    it("rename('a', 'a') is a no-op and returns true", () => {
      registry.add(makeEntry("a", { filePath: "/a.csv" }));
      changeSpy.mockReset();
      const result = registry.rename("a", "a");
      expect(result).toBe(true);
      expect(registry.get("a")!.filePath).toBe("/a.csv");
      expect(changeSpy).not.toHaveBeenCalled();
    });

    it("does not modify registry when newName collision throws", () => {
      registry.add(makeEntry("a", { filePath: "/a.csv" }));
      registry.add(makeEntry("b", { filePath: "/b.csv" }));
      try {
        registry.rename("a", "b");
      } catch {
        // expected
      }
      // Both entries must still exist with their original filePaths
      expect(registry.has("a")).toBe(true);
      expect(registry.has("b")).toBe(true);
      expect(registry.get("a")!.filePath).toBe("/a.csv");
      expect(registry.get("b")!.filePath).toBe("/b.csv");
    });
  });

  describe("updateColumns", () => {
    it("updates columns on an existing entry and fires event", () => {
      registry.add(makeEntry("t"));
      changeSpy.mockReset();
      registry.updateColumns("t", [{ name: "id", type: "INTEGER" }]);
      expect(registry.get("t")!.columns).toEqual([{ name: "id", type: "INTEGER" }]);
      expect(changeSpy).toHaveBeenCalledTimes(1);
    });

    it("is a no-op for missing entries", () => {
      changeSpy.mockReset();
      registry.updateColumns("missing", [{ name: "x", type: "TEXT" }]);
      expect(changeSpy).not.toHaveBeenCalled();
    });
  });

  describe("persistence (memento)", () => {
    it("loadFromStorage restores entries from memento", () => {
      const memento = new MockMemento();
      const entries = [makeEntry("persisted")];
      memento.update("fileSql.registeredTables", entries);

      registry.setStorage(memento as unknown as import("vscode").Memento);
      const loaded = registry.loadFromStorage();
      expect(loaded).toHaveLength(1);
      expect(registry.has("persisted")).toBe(true);
    });

    it("loadFromStorage returns empty array without memento", () => {
      const loaded = registry.loadFromStorage();
      expect(loaded).toEqual([]);
    });
  });

  describe("dispose", () => {
    it("disposes the event emitter without throwing", () => {
      expect(() => registry.dispose()).not.toThrow();
    });
  });
});
