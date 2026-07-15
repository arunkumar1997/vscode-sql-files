import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted to define mock functions before vi.mock hoisting
const { mockSend, mockFromIni, mockPipeline, mockCreateWriteStream, mockMkdtempSync, mockMkdirSync, mockRmSync } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockFromIni: vi.fn(),
  mockPipeline: vi.fn().mockResolvedValue(undefined),
  mockCreateWriteStream: vi.fn().mockReturnValue({}),
  mockMkdtempSync: vi.fn((prefix: string) => `${prefix}abc123`),
  mockMkdirSync: vi.fn(),
  mockRmSync: vi.fn(),
}));

vi.mock("@aws-sdk/credential-providers", () => ({
  fromIni: mockFromIni,
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class MockS3Client {
    send = mockSend;
    destroy() {}
  },
  GetBucketLocationCommand: class {
    constructor(public input?: any) {}
  },
  ListObjectsV2Command: class {
    constructor(public input?: any) {}
  },
  GetObjectCommand: class {
    constructor(public input?: any) {}
  },
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    mkdtempSync: mockMkdtempSync,
    mkdirSync: mockMkdirSync,
    rmSync: mockRmSync,
    createWriteStream: mockCreateWriteStream,
  };
});

vi.mock("stream/promises", () => ({
  pipeline: mockPipeline,
}));

import { parseS3Uri, resolveAwsCredentials, detectBucketRegion, listS3Keys, groupKeysByLeafPrefix, groupS3KeysByFileType, findHivePartitionPrefixes, entryFromS3File, getConfig, cleanupTempDir, downloadS3File, downloadS3Entries, downloadS3Folder, downloadS3HiveFolder } from "../../src/s3Handler";

describe("parseS3Uri", () => {
  it("parses bucket-only URI (no trailing slash)", () => {
    const result = parseS3Uri("s3://my-bucket");
    expect(result).toEqual({ bucket: "my-bucket", prefix: "", isFolder: true });
  });

  it("parses bucket with trailing slash", () => {
    const result = parseS3Uri("s3://my-bucket/");
    expect(result).toEqual({ bucket: "my-bucket", prefix: "", isFolder: true });
  });

  it("parses single file key", () => {
    const result = parseS3Uri("s3://data-lake/warehouse/facts.parquet");
    expect(result).toEqual({
      bucket: "data-lake",
      prefix: "warehouse/facts.parquet",
      isFolder: false,
    });
  });

  it("parses folder key with trailing slash", () => {
    const result = parseS3Uri("s3://data-lake/warehouse/");
    expect(result).toEqual({
      bucket: "data-lake",
      prefix: "warehouse/",
      isFolder: true,
    });
  });

  it("returns null for non-S3 URIs", () => {
    expect(parseS3Uri("https://example.com")).toBeNull();
    expect(parseS3Uri("file:///tmp/data.csv")).toBeNull();
    expect(parseS3Uri("")).toBeNull();
  });

  it("returns null for malformed URIs", () => {
    expect(parseS3Uri("s3://")).toBeNull();
  });

  it("handles keys with special characters", () => {
    const result = parseS3Uri("s3://bucket/path/to/my file (1).csv");
    expect(result).not.toBeNull();
    expect(result!.bucket).toBe("bucket");
    expect(result!.prefix).toBe("path/to/my file (1).csv");
    expect(result!.isFolder).toBe(false);
  });
});

describe("resolveAwsCredentials", () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockFromIni.mockReset();
  });

  it("calls fromIni with the given profile and returns credentials", async () => {
    const mockCreds = {
      accessKeyId: "AKIA_TEST",
      secretAccessKey: "secret_test",
      sessionToken: "token_test",
    };
    mockFromIni.mockReturnValue(vi.fn(async () => mockCreds));

    const result = await resolveAwsCredentials("myprofile");
    expect(mockFromIni).toHaveBeenCalledWith({ profile: "myprofile" });
    expect(result).toEqual({
      keyId: "AKIA_TEST",
      secret: "secret_test",
      token: "token_test",
    });
  });

  it("returns undefined token when sessionToken is absent", async () => {
    const mockCreds = {
      accessKeyId: "AKIA_TEST",
      secretAccessKey: "secret_test",
    };
    mockFromIni.mockReturnValue(vi.fn(async () => mockCreds));

    const result = await resolveAwsCredentials("default");
    expect(result.token).toBeUndefined();
  });
});

describe("detectBucketRegion", () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it("returns the LocationConstraint from S3 response", async () => {
    mockSend.mockResolvedValueOnce({ LocationConstraint: "eu-west-1" });

    const region = await detectBucketRegion("my-bucket", {
      keyId: "AK",
      secret: "SK",
    });
    expect(region).toBe("eu-west-1");
  });

  it("returns us-east-1 when LocationConstraint is null (us-east-1 bucket)", async () => {
    mockSend.mockResolvedValueOnce({ LocationConstraint: null });

    const region = await detectBucketRegion("us-bucket", {
      keyId: "AK",
      secret: "SK",
    });
    expect(region).toBe("us-east-1");
  });

  it("returns us-east-1 when LocationConstraint is undefined", async () => {
    mockSend.mockResolvedValueOnce({});

    const region = await detectBucketRegion("default-bucket", {
      keyId: "AK",
      secret: "SK",
    });
    expect(region).toBe("us-east-1");
  });
});

describe("listS3Keys", () => {
  const creds = { keyId: "AK", secret: "SK" };

  beforeEach(() => {
    mockSend.mockReset();
  });

  it("returns keys from a single page response", async () => {
    mockSend.mockResolvedValueOnce({
      Contents: [{ Key: "data/a.csv" }, { Key: "data/b.csv" }],
      NextContinuationToken: undefined,
    });

    const keys = await listS3Keys("bucket", "data/", "us-east-1", creds);
    expect(keys).toEqual(["data/a.csv", "data/b.csv"]);
  });

  it("handles pagination across multiple pages", async () => {
    mockSend
      .mockResolvedValueOnce({
        Contents: [{ Key: "a.csv" }],
        NextContinuationToken: "token1",
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: "b.csv" }],
        NextContinuationToken: undefined,
      });

    const keys = await listS3Keys("bucket", "", "us-east-1", creds);
    expect(keys).toEqual(["a.csv", "b.csv"]);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("returns empty array when Contents is undefined", async () => {
    mockSend.mockResolvedValueOnce({
      Contents: undefined,
      NextContinuationToken: undefined,
    });

    const keys = await listS3Keys("bucket", "empty/", "us-east-1", creds);
    expect(keys).toEqual([]);
  });

  it("skips entries without Key", async () => {
    mockSend.mockResolvedValueOnce({
      Contents: [{ Key: "valid.csv" }, {}, { Key: "also-valid.csv" }],
      NextContinuationToken: undefined,
    });

    const keys = await listS3Keys("bucket", "", "us-east-1", creds);
    expect(keys).toEqual(["valid.csv", "also-valid.csv"]);
  });
});

describe("groupKeysByLeafPrefix", () => {
  it("groups keys by their parent directory prefix", () => {
    const keys = ["data/a.csv", "data/b.csv", "logs/c.json"];
    const groups = groupKeysByLeafPrefix(keys);
    expect(groups.size).toBe(2);
    expect(groups.get("data/")).toEqual(["data/a.csv", "data/b.csv"]);
    expect(groups.get("logs/")).toEqual(["logs/c.json"]);
  });

  it("groups root-level keys under empty prefix", () => {
    const keys = ["root.csv"];
    const groups = groupKeysByLeafPrefix(keys);
    expect(groups.get("")).toEqual(["root.csv"]);
  });
});

describe("groupS3KeysByFileType", () => {
  it("groups supported keys by file type and extension", () => {
    const keys = ["a.csv", "b.csv", "c.json", "d.png"];
    const groups = groupS3KeysByFileType(keys);
    expect(groups).toHaveLength(2); // csv + json; png skipped
    const csvGroup = groups.find((g) => g.fileType === "csv");
    expect(csvGroup!.keys).toEqual(["a.csv", "b.csv"]);
  });

  it("returns empty array for all unsupported keys", () => {
    const groups = groupS3KeysByFileType(["x.zip", "y.tar"]);
    expect(groups).toEqual([]);
  });
});

describe("findHivePartitionPrefixes", () => {
  it("detects a single Hive-partitioned prefix", () => {
    const keys = [
      "data/year=2024/month=01/file.parquet",
      "data/year=2024/month=02/file.parquet",
    ];
    const prefixes = findHivePartitionPrefixes(keys, "data/");
    expect(prefixes).toEqual(["data/"]);
  });

  it("returns empty for non-Hive structure", () => {
    const keys = ["data/subdir/file.csv"];
    const prefixes = findHivePartitionPrefixes(keys, "data/");
    expect(prefixes).toEqual([]);
  });

  it("handles empty root prefix", () => {
    const keys = ["year=2024/file.csv"];
    const prefixes = findHivePartitionPrefixes(keys, "");
    expect(prefixes).toEqual([""]);
  });

  it("normalizes root prefix without trailing slash", () => {
    const keys = ["data/year=2024/file.parquet"];
    const prefixes = findHivePartitionPrefixes(keys, "data");
    expect(prefixes).toEqual(["data/"]);
  });

  it("filters out unsupported file types in hive paths", () => {
    const keys = ["data/year=2024/readme.md"];
    const prefixes = findHivePartitionPrefixes(keys, "data/");
    expect(prefixes).toEqual([]);
  });
});

describe("entryFromS3File", () => {
  it("parses a valid S3 file URI", () => {
    const result = entryFromS3File("s3://bucket/path/to/data.csv");
    expect(result).not.toBeNull();
    expect(result!.bucket).toBe("bucket");
    expect(result!.prefix).toBe("path/to/data.csv");
    expect(result!.fileType).toBe("csv");
  });

  it("returns null for folder URIs", () => {
    expect(entryFromS3File("s3://bucket/path/")).toBeNull();
  });

  it("returns null for unsupported file types", () => {
    expect(entryFromS3File("s3://bucket/photo.png")).toBeNull();
  });

  it("returns null for non-S3 URIs", () => {
    expect(entryFromS3File("https://example.com/file.csv")).toBeNull();
  });
});

describe("getConfig", () => {
  it("returns default configuration values", () => {
    const config = getConfig();
    expect(config).toHaveProperty("profile");
    expect(config).toHaveProperty("region");
    expect(config).toHaveProperty("maxRows");
  });
});

describe("downloadS3File", () => {
  const creds = { keyId: "AK", secret: "SK" };

  beforeEach(() => {
    mockSend.mockReset();
    mockPipeline.mockReset().mockResolvedValue(undefined);
    mockCreateWriteStream.mockReset().mockReturnValue({});
  });

  it("downloads an S3 object and pipes it to a local file", async () => {
    const fakeBody = "fake-stream-body";
    mockSend.mockResolvedValueOnce({ Body: fakeBody });

    await downloadS3File("bucket", "data.csv", "/tmp/data.csv", creds, "us-east-1");

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockCreateWriteStream).toHaveBeenCalledWith("/tmp/data.csv");
    expect(mockPipeline).toHaveBeenCalledWith(fakeBody, expect.anything());
  });
});

describe("downloadS3Entries", () => {
  const creds = { keyId: "AK", secret: "SK" };
  const mockProgress = { report: vi.fn() };

  beforeEach(() => {
    mockSend.mockReset();
    mockPipeline.mockReset().mockResolvedValue(undefined);
    mockCreateWriteStream.mockReset().mockReturnValue({});
    mockMkdtempSync.mockReset().mockImplementation((prefix: string) => `${prefix}abc123`);
  });

  it("downloads supported files and returns table entries", async () => {
    mockSend.mockResolvedValue({ Body: "stream" });

    const entries = await downloadS3Entries(
      "bucket",
      ["path/data.csv", "path/events.json"],
      creds,
      "us-east-1",
      mockProgress as any,
    );

    expect(entries).toHaveLength(2);
    expect(entries[0].name).toBe("data");
    expect(entries[0].fileType).toBe("csv");
    expect(entries[0].isS3).toBe(true);
    expect(entries[0].sourceUri).toBe("s3://bucket/path/data.csv");
    expect(entries[1].fileType).toBe("json");
  });

  it("skips unsupported file types", async () => {
    mockSend.mockResolvedValue({ Body: "stream" });

    const entries = await downloadS3Entries(
      "bucket",
      ["readme.md", "data.csv"],
      creds,
      "us-east-1",
      mockProgress as any,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].fileType).toBe("csv");
  });

  it("deduplicates table names", async () => {
    mockSend.mockResolvedValue({ Body: "stream" });

    const entries = await downloadS3Entries(
      "bucket",
      ["a/data.csv", "b/data.csv"],
      creds,
      "us-east-1",
      mockProgress as any,
    );

    expect(entries).toHaveLength(2);
    const names = entries.map((e) => e.name);
    expect(new Set(names).size).toBe(2);
    expect(names).toContain("data");
    expect(names).toContain("data_1");
  });

  it("reports download progress", async () => {
    mockSend.mockResolvedValue({ Body: "stream" });

    await downloadS3Entries(
      "bucket",
      ["file.csv"],
      creds,
      "us-east-1",
      mockProgress as any,
    );

    expect(mockProgress.report).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("file.csv") }),
    );
  });
});

describe("downloadS3Folder", () => {
  const creds = { keyId: "AK", secret: "SK" };
  const mockProgress = { report: vi.fn() };

  beforeEach(() => {
    mockSend.mockReset();
    mockPipeline.mockReset().mockResolvedValue(undefined);
    mockCreateWriteStream.mockReset().mockReturnValue({});
    mockMkdtempSync.mockReset().mockImplementation((prefix: string) => `${prefix}abc123`);
    mockMkdirSync.mockReset();
    mockProgress.report.mockReset();
  });

  it("downloads folder of part files and returns a single table entry", async () => {
    mockSend.mockResolvedValue({ Body: "stream" });

    const entry = await downloadS3Folder(
      "bucket",
      "warehouse/orders/",
      ["warehouse/orders/part-0.parquet", "warehouse/orders/part-1.parquet"],
      creds,
      "us-east-1",
      mockProgress as any,
    );

    expect(entry).not.toBeNull();
    expect(entry!.name).toBe("orders");
    expect(entry!.fileType).toBe("parquet");
    expect(entry!.isS3).toBe(true);
    expect(entry!.filePath).toContain("*.parquet");
    expect(entry!.sourceUri).toBe("s3://bucket/warehouse/orders/");
  });

  it("returns null when no supported keys exist", async () => {
    const entry = await downloadS3Folder(
      "bucket",
      "logs/",
      ["logs/readme.md", "logs/config.yaml"],
      creds,
      "us-east-1",
      mockProgress as any,
    );

    expect(entry).toBeNull();
  });

  it("reports progress for each downloaded file", async () => {
    mockSend.mockResolvedValue({ Body: "stream" });

    await downloadS3Folder(
      "bucket",
      "data/",
      ["data/a.csv", "data/b.csv"],
      creds,
      "us-east-1",
      mockProgress as any,
    );

    expect(mockProgress.report).toHaveBeenCalledTimes(2);
  });
});

describe("downloadS3HiveFolder", () => {
  const creds = { keyId: "AK", secret: "SK" };
  const mockProgress = { report: vi.fn() };

  beforeEach(() => {
    mockSend.mockReset();
    mockPipeline.mockReset().mockResolvedValue(undefined);
    mockCreateWriteStream.mockReset().mockReturnValue({});
    mockMkdtempSync.mockReset().mockImplementation((prefix: string) => `${prefix}abc123`);
    mockMkdirSync.mockReset();
    mockProgress.report.mockReset();
  });

  it("downloads Hive-partitioned dataset preserving directory structure", async () => {
    mockSend.mockResolvedValue({ Body: "stream" });

    const entry = await downloadS3HiveFolder(
      "bucket",
      "data/",
      ["data/year=2024/month=01/part.parquet", "data/year=2024/month=02/part.parquet"],
      creds,
      "us-east-1",
      mockProgress as any,
      "parquet",
      ".parquet",
      false,
    );

    expect(entry).not.toBeNull();
    expect(entry!.name).toBe("data");
    expect(entry!.fileType).toBe("parquet");
    expect(entry!.isS3).toBe(true);
    expect(entry!.hivePartitioning).toBe(true);
    expect(entry!.filePath).toContain("**");
    expect(entry!.filePath).toContain("*.parquet");
  });

  it("returns null for empty keys array", async () => {
    const entry = await downloadS3HiveFolder(
      "bucket",
      "data/",
      [],
      creds,
      "us-east-1",
      mockProgress as any,
      "csv",
      ".csv",
      false,
    );

    expect(entry).toBeNull();
  });

  it("includes extension in name when requested", async () => {
    mockSend.mockResolvedValue({ Body: "stream" });

    const entry = await downloadS3HiveFolder(
      "bucket",
      "mixed/",
      ["mixed/year=2024/part.csv"],
      creds,
      "us-east-1",
      mockProgress as any,
      "csv",
      ".csv",
      true,
    );

    expect(entry).not.toBeNull();
    expect(entry!.name).toBe("mixed_csv");
  });

  it("throws for malicious relative paths", async () => {
    mockSend.mockResolvedValue({ Body: "stream" });

    await expect(
      downloadS3HiveFolder(
        "bucket",
        "data/",
        ["data/../../../etc/passwd"],
        creds,
        "us-east-1",
        mockProgress as any,
        "csv",
        ".csv",
        false,
      ),
    ).rejects.toThrow("Invalid object key");
  });
});

describe("cleanupTempDir", () => {
  beforeEach(() => {
    mockRmSync.mockReset();
  });

  it("does not throw when no temp dir exists", () => {
    expect(() => cleanupTempDir()).not.toThrow();
  });
});
