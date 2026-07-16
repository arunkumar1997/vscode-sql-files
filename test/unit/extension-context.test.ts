import { describe, expect, it } from "vitest";
import { tableNameFromContext } from "../../src/extension";

describe("tableNameFromContext", () => {
    it("reads a table name from a tree item", () => {
        expect(tableNameFromContext({ entry: { name: "sales" } })).toBe("sales");
    });

    it("accepts explicit table names and ignores unrelated command context", () => {
        expect(tableNameFromContext("events")).toBe("events");
        expect(tableNameFromContext({ scheme: "file", path: "/workspace" })).toBeUndefined();
    });
});
