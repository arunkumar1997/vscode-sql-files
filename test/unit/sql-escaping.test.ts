import { describe, it, expect } from "vitest";
import { escapeSqlString, escapeDuckDBIdentifier } from "../../src/duckdbEngine";

describe("DuckDB SQL Escaping — escapeSqlString", () => {
    it("doubles single quotes", () => {
        expect(escapeSqlString("it's a test")).toBe("it''s a test");
    });

    it("handles multiple single quotes", () => {
        expect(escapeSqlString("a''b'c")).toBe("a''''b''c");
    });

    it("passes through strings without quotes unchanged", () => {
        expect(escapeSqlString("normal/path/to/file.csv")).toBe("normal/path/to/file.csv");
    });

    it("rejects NUL bytes", () => {
        expect(() => escapeSqlString("bad\0data")).toThrow(/NUL/);
    });

    it("handles empty string", () => {
        expect(escapeSqlString("")).toBe("");
    });

    it("handles paths with special chars", () => {
        expect(escapeSqlString("/tmp/file-sql-abc/data's folder/file.csv"))
            .toBe("/tmp/file-sql-abc/data''s folder/file.csv");
    });
});

describe("DuckDB SQL Escaping — escapeDuckDBIdentifier", () => {
    it("wraps simple name in double quotes", () => {
        expect(escapeDuckDBIdentifier("sales")).toBe('"sales"');
    });

    it("doubles embedded double quotes", () => {
        expect(escapeDuckDBIdentifier('my"table')).toBe('"my""table"');
    });

    it("handles names with spaces", () => {
        expect(escapeDuckDBIdentifier("my table")).toBe('"my table"');
    });

    it("handles names with special characters", () => {
        expect(escapeDuckDBIdentifier("table-2024.v1")).toBe('"table-2024.v1"');
    });

    it("rejects empty string", () => {
        expect(() => escapeDuckDBIdentifier("")).toThrow(/empty/);
    });

    it("rejects NUL bytes", () => {
        expect(() => escapeDuckDBIdentifier("bad\0name")).toThrow(/NUL/);
    });

    it("handles underscore-prefixed names", () => {
        expect(escapeDuckDBIdentifier("_internal")).toBe('"_internal"');
    });
});
