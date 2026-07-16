import { describe, it, expect, vi } from "vitest";

// App.tsx calls acquireVsCodeApi() at module scope — define before import evaluates
vi.hoisted(() => {
    (globalThis as unknown as Record<string, unknown>).acquireVsCodeApi = () => ({
        postMessage: () => { },
    });
});

const { isUntouchedInitialTabs } = await import("../../src/webview/App");

describe("isUntouchedInitialTabs", () => {
    const initial = {
        id: "tab-1",
        label: "untitled-1",
        sql: "SELECT *\nFROM ",
        result: null,
        error: null,
        running: false,
        exporting: false,
        exportStatus: null,
        exportError: null,
    };

    it("returns true for a single unmodified initial tab", () => {
        expect(isUntouchedInitialTabs([{ ...initial }], initial)).toBe(true);
    });

    it("returns false when SQL has been edited", () => {
        expect(
            isUntouchedInitialTabs([{ ...initial, sql: "SELECT 1" }], initial),
        ).toBe(false);
    });

    it("returns false when label has been renamed", () => {
        expect(
            isUntouchedInitialTabs([{ ...initial, label: "my-query" }], initial),
        ).toBe(false);
    });

    it("returns false when multiple tabs exist", () => {
        expect(isUntouchedInitialTabs([initial, initial], initial)).toBe(false);
    });

    it("returns false for different id", () => {
        expect(
            isUntouchedInitialTabs([{ ...initial, id: "tab-99" }], initial),
        ).toBe(false);
    });
});
