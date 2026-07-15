import { describe, it, expect, afterEach, vi } from "vitest";
import path from "path";
import fs from "fs";
import { Readable } from "stream";
import { createEngine, EngineHarness } from "../helpers/duckdbHarness";
import { createTempDir, TempDir } from "../helpers/tempDir";
import { downloadS3File, downloadS3Folder, cleanupTempDir } from "../../src/s3Handler";

const FIXTURES = path.resolve(__dirname, "../fixtures");

// Hoist mockSend so vi.mock factory can reference it
const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => {
  class MockS3Client {
    send = mockSend;
  }
  class MockGetObjectCommand {
    [key: string]: unknown;
    constructor(params: Record<string, string>) {
      Object.assign(this, params);
    }
  }
  return {
    S3Client: MockS3Client,
    GetObjectCommand: MockGetObjectCommand,
  };
});

const FAKE_CREDS = {
  keyId: "AKIAIOSFODNN7EXAMPLE",
  secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

describe("S3 download → DuckDB integration", () => {
  let harness: EngineHarness;
  let tempDir: TempDir;

  afterEach(() => {
    harness?.dispose();
    tempDir?.cleanup();
    cleanupTempDir();
    mockSend.mockReset();
  });

  it("downloads a single S3 CSV, registers it, and queries it", async () => {
    harness = await createEngine();
    tempDir = createTempDir();

    const fixtureBytes = fs.readFileSync(path.join(FIXTURES, "sales.csv"));
    mockSend.mockResolvedValueOnce({
      Body: Readable.from(fixtureBytes),
    });

    const destPath = path.join(tempDir.path, "s3-sales.csv");
    await downloadS3File(
      "test-bucket",
      "data/sales.csv",
      destPath,
      FAKE_CREDS,
      "us-east-1",
    );

    // File should exist locally
    expect(fs.existsSync(destPath)).toBe(true);

    // Register in DuckDB and query
    await harness.engine.registerTable({
      name: "s3_sales",
      filePath: destPath,
      fileType: "csv",
      isS3: true,
    });
    const result = await harness.engine.executeQuery(
      "SELECT COUNT(*) AS cnt FROM s3_sales",
      100,
    );
    expect(Number(result.rows[0].cnt)).toBe(5);
  });

  it("downloads S3 folder (2 keys) and produces one glob table entry", async () => {
    harness = await createEngine();

    // Mock S3 responses for two part-files
    mockSend.mockImplementation(async (cmd: Record<string, string>) => {
      const key = cmd.Key;
      if (key === "data/part-1.csv") {
        return {
          Body: Readable.from(
            fs.readFileSync(path.join(FIXTURES, "folder-a", "part-1.csv")),
          ),
        };
      }
      if (key === "data/part-2.csv") {
        return {
          Body: Readable.from(
            fs.readFileSync(path.join(FIXTURES, "folder-a", "part-2.csv")),
          ),
        };
      }
      throw new Error(`Unexpected key: ${key}`);
    });

    const entry = await downloadS3Folder(
      "test-bucket",
      "data/",
      ["data/part-1.csv", "data/part-2.csv"],
      FAKE_CREDS,
      "us-east-1",
      { report: vi.fn() } as never,
    );

    expect(entry).not.toBeNull();
    expect(entry!.filePath).toContain("*.csv");

    // Register in DuckDB and query
    await harness.engine.registerTable(entry!);
    const result = await harness.engine.executeQuery(
      `SELECT COUNT(*) AS cnt FROM "${entry!.name}"`,
      100,
    );
    expect(Number(result.rows[0].cnt)).toBe(6);
  });
});
