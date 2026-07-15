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

describe("downloadS3File abort mid-stream (real pipeline)", () => {
  let tempDir: TempDir;

  afterEach(() => {
    tempDir?.cleanup();
    cleanupTempDir();
    mockSend.mockReset();
  });

  it("rejects with AbortError and tears down streams after data reaches disk", async () => {
    tempDir = createTempDir();
    const destPath = path.join(tempDir.path, "abort-mid.csv");
    const ac = new AbortController();

    // Full payload the source *would* deliver if not aborted
    const HEADER = "id,name\n";
    const ROW = "1,alice\n";
    const CHUNK_SIZE = 4096;
    const TOTAL_CHUNKS = 50;
    const firstChunk = Buffer.from(HEADER + ROW.repeat(CHUNK_SIZE));
    const fullPayloadSize = firstChunk.length * TOTAL_CHUNKS;

    let firstChunkPushed = false;
    let bytesOnDiskBeforeAbort = -1;
    let chunksDelivered = 0;

    // Poll destPath with bounded retries until it has nonzero bytes.
    // Resolves with the observed size, or rejects after the guard limit.
    function waitForNonzeroFile(filePath: string, maxTicks: number): Promise<number> {
      return new Promise<number>((resolve, reject) => {
        let ticks = 0;
        function check() {
          ticks++;
          try {
            const stat = fs.statSync(filePath);
            if (stat.size > 0) {
              return resolve(stat.size);
            }
          } catch {
            // file may not exist yet
          }
          if (ticks >= maxTicks) {
            return reject(new Error(`File never reached nonzero bytes after ${maxTicks} ticks`));
          }
          setImmediate(check);
        }
        setImmediate(check);
      });
    }

    // Custom Readable: pushes one large chunk, waits for bytes on disk,
    // then fires abort — keeping the source open the whole time.
    const source = new Readable({
      read() {
        if (!firstChunkPushed) {
          firstChunkPushed = true;
          chunksDelivered++;
          this.push(firstChunk);

          // After pushing the chunk, poll until the destination file
          // has nonzero bytes — only *then* fire abort.
          waitForNonzeroFile(destPath, 200).then((size) => {
            bytesOnDiskBeforeAbort = size;
            ac.abort();
          }).catch(() => {
            // Guard: if file never appeared, abort anyway to avoid hanging
            ac.abort();
          });
        } else if (!ac.signal.aborted) {
          // Keep delivering more data so the stream stays active
          chunksDelivered++;
          this.push(firstChunk);
        }
        // Once aborted, stop pushing — pipeline teardown handles the rest
      },
    });

    mockSend.mockResolvedValueOnce({ Body: source });

    const rejection = downloadS3File(
      "test-bucket",
      "data.csv",
      destPath,
      FAKE_CREDS,
      "us-east-1",
      ac.signal,
    );

    // Must reject — pipeline must NOT resolve successfully
    const err: any = await rejection.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("ABORT_ERR");

    // Abort happened mid-stream, not pre-stream
    expect(firstChunkPushed).toBe(true);

    // We observed nonzero bytes on disk *before* aborting
    expect(bytesOnDiskBeforeAbort).toBeGreaterThan(0);

    // Source stream must be destroyed (pipeline teardown)
    expect(source.destroyed).toBe(true);

    // Destination file must exist with partial data
    expect(fs.existsSync(destPath)).toBe(true);
    const finalSize = fs.statSync(destPath).size;
    expect(finalSize).toBeGreaterThan(0);
    expect(finalSize).toBeLessThan(fullPayloadSize);
  });
});
