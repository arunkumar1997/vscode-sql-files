import { describe, expect, it } from "vitest";
import {
    ensureUniqueQueryNames,
    uniqueQueryName,
} from "../../src/queryNames";

describe("query names", () => {
    it("adds deterministic suffixes without changing order", () => {
        expect(
            ensureUniqueQueryNames([
                { name: "Sales", sql: "SELECT 1" },
                { name: "sales", sql: "SELECT 2" },
                { name: "Sales", sql: "SELECT 3" },
            ]),
        ).toEqual([
            { name: "Sales", sql: "SELECT 1" },
            { name: "sales (2)", sql: "SELECT 2" },
            { name: "Sales (3)", sql: "SELECT 3" },
        ]);
    });

    it("trims names and fills empty names", () => {
        expect(uniqueQueryName(" Report ", [])).toBe("Report");
        expect(uniqueQueryName(" ", [])).toBe("untitled");
    });

    it("uses the next available suffix", () => {
        expect(uniqueQueryName("Query", ["query", "Query (2)"])).toBe(
            "Query (3)",
        );
    });
});