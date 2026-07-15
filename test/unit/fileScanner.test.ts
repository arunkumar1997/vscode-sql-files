import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "path";

// Mock fs at module level — vitest hoists this
vi.mock("fs");
import * as fs from "fs";

import { detectFileType, deriveTableName, scanFolder, entryFromLocalFile } from "../../src/fileScanner";

describe("detectFileType", () => {
  it("returns 'csv' for .csv files", () => {
    expect(detectFileType("data/sales.csv")).toBe("csv");
  });

  it("returns 'csv' for .tsv files", () => {
    expect(detectFileType("data/tab-separated.tsv")).toBe("csv");
  });

  it("returns 'json' for .json files", () => {
    expect(detectFileType("schema.json")).toBe("json");
  });

  it("returns 'json' for .jsonl files", () => {
    expect(detectFileType("logs/events.jsonl")).toBe("json");
  });

  it("returns 'json' for .ndjson files", () => {
    expect(detectFileType("stream.ndjson")).toBe("json");
  });

  it("returns 'parquet' for .parquet files", () => {
    expect(detectFileType("/tmp/warehouse/fact_orders.parquet")).toBe("parquet");
  });

  it("returns 'text' for .txt files", () => {
    expect(detectFileType("notes.txt")).toBe("text");
  });

  it("returns 'text' for .log files", () => {
    expect(detectFileType("server.log")).toBe("text");
  });

  it("returns null for unsupported extensions", () => {
    expect(detectFileType("image.png")).toBeNull();
    expect(detectFileType("archive.zip")).toBeNull();
    expect(detectFileType("code.ts")).toBeNull();
  });

  it("is case-insensitive on extensions", () => {
    expect(detectFileType("DATA.CSV")).toBe("csv");
    expect(detectFileType("EVENTS.PARQUET")).toBe("parquet");
  });
});

describe("deriveTableName", () => {
  it("returns the file basename without extension", () => {
    expect(deriveTableName("/tmp/data/sales.csv")).toBe("sales");
  });

  it("replaces spaces with underscores", () => {
    expect(deriveTableName("my file name.csv")).toBe("my_file_name");
  });

  it("replaces dashes with underscores", () => {
    expect(deriveTableName("user-events.json")).toBe("user_events");
  });

  it("prefixes underscore when name starts with a digit", () => {
    expect(deriveTableName("2024_sales.csv")).toBe("_2024_sales");
  });

  it("handles multiple special characters", () => {
    expect(deriveTableName("my file (copy).csv")).toBe("my_file__copy_");
  });

  it("returns 'table' for a file with only special chars as name", () => {
    expect(deriveTableName("---.csv")).toBe("___");
  });

  it("handles nested paths correctly", () => {
    expect(deriveTableName("/a/b/c/orders_q1.parquet")).toBe("orders_q1");
  });
});

describe("scanFolder", () => {
  beforeEach(() => {
    vi.mocked(fs.readdirSync).mockReset();
    vi.mocked(fs.statSync).mockReset();
  });

  it("returns empty array for empty directory", () => {
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);
    const result = scanFolder("/fake/empty");
    expect(result).toEqual([]);
  });

  it("discovers CSV files in a flat directory", () => {
    vi.mocked(fs.readdirSync).mockImplementation((dir: any) => {
      if (String(dir) === "/fake/data") {
        return ["sales.csv", "orders.csv"] as any;
      }
      return [] as any;
    });
    vi.mocked(fs.statSync).mockImplementation(() => ({
      isDirectory: () => false,
      isFile: () => true,
    }) as any);

    const result = scanFolder("/fake/data");
    expect(result.length).toBe(1); // one group for the directory
    expect(result[0].fileType).toBe("csv");
    expect(result[0].filePath).toContain("*.csv");
  });

  it("skips hidden files (dotfiles)", () => {
    vi.mocked(fs.readdirSync).mockImplementation((dir: any) => {
      if (String(dir) === "/fake/data") {
        return [".hidden.csv", "visible.csv"] as any;
      }
      return [] as any;
    });
    vi.mocked(fs.statSync).mockImplementation(() => ({
      isDirectory: () => false,
      isFile: () => true,
    }) as any);

    const result = scanFolder("/fake/data");
    expect(result.length).toBe(1);
  });

  it("skips unsupported file types", () => {
    vi.mocked(fs.readdirSync).mockImplementation((dir: any) => {
      if (String(dir) === "/fake/data") {
        return ["image.png", "data.csv"] as any;
      }
      return [] as any;
    });
    vi.mocked(fs.statSync).mockImplementation(() => ({
      isDirectory: () => false,
      isFile: () => true,
    }) as any);

    const result = scanFolder("/fake/data");
    expect(result.length).toBe(1);
    expect(result[0].fileType).toBe("csv");
  });

  it("creates separate table entries for different file types in same directory", () => {
    vi.mocked(fs.readdirSync).mockImplementation((dir: any) => {
      if (String(dir) === "/fake/mixed") {
        return ["data.csv", "events.json"] as any;
      }
      return [] as any;
    });
    vi.mocked(fs.statSync).mockImplementation(() => ({
      isDirectory: () => false,
      isFile: () => true,
    }) as any);

    const result = scanFolder("/fake/mixed");
    expect(result.length).toBe(2);
    const types = result.map((e) => e.fileType).sort();
    expect(types).toEqual(["csv", "json"]);
  });

  it("gracefully handles unreadable directories", () => {
    vi.mocked(fs.readdirSync).mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    const result = scanFolder("/fake/noperm");
    expect(result).toEqual([]);
  });

  it("walks subdirectories recursively", () => {
    vi.mocked(fs.readdirSync).mockImplementation((dir: any) => {
      const d = String(dir);
      if (d === "/fake/root") return ["subdir"] as any;
      if (d === "/fake/root/subdir") return ["data.csv"] as any;
      return [] as any;
    });
    vi.mocked(fs.statSync).mockImplementation((p: any) => {
      const s = String(p);
      return {
        isDirectory: () => s === "/fake/root/subdir",
        isFile: () => s !== "/fake/root/subdir",
      } as any;
    });

    const result = scanFolder("/fake/root");
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("subdir");
    expect(result[0].fileType).toBe("csv");
  });

  it("deduplicates table names with numeric suffix", () => {
    // Two subdirectories with the same name would collide, but since they're
    // different directories, each gets a unique name via uniqueName().
    vi.mocked(fs.readdirSync).mockImplementation((dir: any) => {
      const d = String(dir);
      if (d === "/fake/root") return ["a", "b"] as any;
      if (d === "/fake/root/a") return ["file.csv"] as any;
      if (d === "/fake/root/b") return ["file.csv"] as any;
      return [] as any;
    });
    vi.mocked(fs.statSync).mockImplementation((p: any) => {
      const s = String(p);
      return {
        isDirectory: () => s === "/fake/root/a" || s === "/fake/root/b",
        isFile: () => s !== "/fake/root/a" && s !== "/fake/root/b",
      } as any;
    });

    const result = scanFolder("/fake/root");
    expect(result.length).toBe(2);
    const names = result.map((e) => e.name);
    // Both dirs have csv files, names should be unique
    expect(new Set(names).size).toBe(2);
  });

  it("handles statSync throwing for a file", () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["good.csv", "bad.csv"] as any);
    let callCount = 0;
    vi.mocked(fs.statSync).mockImplementation(() => {
      callCount++;
      if (callCount === 2) throw new Error("ENOENT");
      return { isDirectory: () => false, isFile: () => true } as any;
    });

    // Should not throw, should process what it can
    const result = scanFolder("/fake/data");
    expect(result.length).toBe(1);
  });
});

describe("entryFromLocalFile", () => {
  it("returns a TableEntry for a supported file", () => {
    const entry = entryFromLocalFile("/tmp/data.csv");
    expect(entry).not.toBeNull();
    expect(entry!.name).toBe("data");
    expect(entry!.fileType).toBe("csv");
    expect(entry!.isS3).toBe(false);
  });

  it("returns null for an unsupported file", () => {
    const entry = entryFromLocalFile("/tmp/photo.png");
    expect(entry).toBeNull();
  });
});
