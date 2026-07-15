import { describe, it, expect } from "vitest";

// exportHelpers is under src/webview but is a pure TS module with no DOM deps,
// so it can be tested directly in Node via vitest unit config.
import { isExportEnabled, isSuccessStatus, formatExportStatus } from "../../src/webview/exportHelpers";

describe("exportHelpers — isExportEnabled", () => {
  it("returns false when result is null", () => {
    expect(isExportEnabled(null, false, false)).toBe(false);
  });

  it("returns false when running", () => {
    const result = { columns: [{ name: "a", type: "VARCHAR" }], rows: [{ a: 1 }], rowCount: 1, truncated: false };
    expect(isExportEnabled(result, true, false)).toBe(false);
  });

  it("returns false when exporting", () => {
    const result = { columns: [{ name: "a", type: "VARCHAR" }], rows: [{ a: 1 }], rowCount: 1, truncated: false };
    expect(isExportEnabled(result, false, true)).toBe(false);
  });

  it("returns false when result has 0 rows (non-row statement)", () => {
    const result = { columns: [], rows: [], rowCount: 0, truncated: false };
    expect(isExportEnabled(result, false, false)).toBe(false);
  });

  it("returns true when result has rows and not running/exporting", () => {
    const result = { columns: [{ name: "a", type: "VARCHAR" }], rows: [{ a: 1 }], rowCount: 1, truncated: false };
    expect(isExportEnabled(result, false, false)).toBe(true);
  });
});

describe("exportHelpers — isSuccessStatus", () => {
  it("returns true for a non-row result (0 rows, 0 columns)", () => {
    const result = { columns: [], rows: [], rowCount: 0, truncated: false };
    expect(isSuccessStatus(result)).toBe(true);
  });

  it("returns false for a row-producing result", () => {
    const result = { columns: [{ name: "a", type: "VARCHAR" }], rows: [{ a: 1 }], rowCount: 1, truncated: false };
    expect(isSuccessStatus(result)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isSuccessStatus(null)).toBe(false);
  });
});

describe("exportHelpers — formatExportStatus", () => {
  it("returns descriptive text for csv export", () => {
    const text = formatExportStatus("csv", "/path/to/file.csv");
    expect(text).toContain("CSV");
    expect(text).toContain("file.csv");
  });

  it("returns descriptive text for parquet export", () => {
    const text = formatExportStatus("parquet", "/path/to/file.parquet");
    expect(text).toContain("Parquet");
    expect(text).toContain("file.parquet");
  });
});
