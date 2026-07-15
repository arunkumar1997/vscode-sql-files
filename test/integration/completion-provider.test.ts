import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import { TableRegistry } from "../../src/tableRegistry";
import { SqlCompletionProvider } from "../../src/providers/completionProvider";
import { TableEntry } from "../../src/types";

describe("CompletionProvider — integration", () => {
  it("returns table and column names from a populated registry", () => {
    const registry = new TableRegistry();

    const entry: TableEntry = {
      name: "sales",
      filePath: path.join(__dirname, "../fixtures/sales.csv"),
      fileType: "csv",
      isS3: false,
      columns: [
        { name: "id", type: "INTEGER" },
        { name: "region", type: "VARCHAR" },
        { name: "amount", type: "DOUBLE" },
      ],
    };
    registry.add(entry);

    const provider = new SqlCompletionProvider(registry);

    // Create a mock document with a line containing "SELECT * FROM "
    const mockDocument = {
      lineAt: (_pos: unknown) => ({ text: "SELECT * FROM " }),
    };
    const mockPosition = { line: 0, character: 14 };

    const items = provider.provideCompletionItems(
      mockDocument as never,
      mockPosition as never,
    );

    // Should include the table name
    const labels = items.map((i) => i.label);
    expect(labels).toContain("sales");

    // Should include column names
    expect(labels).toContain("id");
    expect(labels).toContain("region");
    expect(labels).toContain("amount");
  });
});
