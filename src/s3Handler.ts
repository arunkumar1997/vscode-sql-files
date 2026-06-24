import { fromIni } from "@aws-sdk/credential-providers";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { TableEntry } from "./types";
import { detectFileType, deriveTableName } from "./fileScanner";

interface S3ParseResult {
  bucket: string;
  prefix: string;
  isFolder: boolean;
}

// Session-scoped temp directory, created on first use
let _tempDir: string | undefined;

function ensureTempDir(): string {
  if (!_tempDir) {
    _tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-sql-"));
  }
  return _tempDir;
}

export function cleanupTempDir(): void {
  if (_tempDir) {
    try {
      fs.rmSync(_tempDir, { recursive: true, force: true });
    } catch {}
    _tempDir = undefined;
  }
}

export function parseS3Uri(uri: string): S3ParseResult | null {
  const match = uri.match(/^s3:\/\/([^/]+)\/?(.*)$/);
  if (!match) {
    return null;
  }
  const bucket = match[1];
  const prefix = match[2] ?? "";
  const isFolder = prefix === "" || prefix.endsWith("/");
  return { bucket, prefix, isFolder };
}

export async function resolveAwsCredentials(profile: string): Promise<{
  keyId: string;
  secret: string;
  token?: string;
}> {
  const provider = fromIni({ profile });
  const creds = await provider();
  return {
    keyId: creds.accessKeyId,
    secret: creds.secretAccessKey,
    token: creds.sessionToken,
  };
}

// Detect the real bucket region via GetBucketLocation (works from any region)
export async function detectBucketRegion(
  bucket: string,
  credentials: { keyId: string; secret: string; token?: string },
): Promise<string> {
  const { S3Client, GetBucketLocationCommand } =
    await import("@aws-sdk/client-s3");
  // us-east-1 endpoint can answer GetBucketLocation for all buckets
  const client = new S3Client({
    region: "us-east-1",
    credentials: {
      accessKeyId: credentials.keyId,
      secretAccessKey: credentials.secret,
      sessionToken: credentials.token,
    },
  });
  const resp = await client.send(
    new GetBucketLocationCommand({ Bucket: bucket }),
  );
  // LocationConstraint is null/undefined for us-east-1 buckets
  return resp.LocationConstraint ?? "us-east-1";
}

export async function listS3Keys(
  bucket: string,
  prefix: string,
  region: string,
  credentials: { keyId: string; secret: string; token?: string },
): Promise<string[]> {
  const { S3Client, ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region,
    credentials: {
      accessKeyId: credentials.keyId,
      secretAccessKey: credentials.secret,
      sessionToken: credentials.token,
    },
  });

  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of resp.Contents ?? []) {
      if (obj.Key) {
        keys.push(obj.Key);
      }
    }
    continuationToken = resp.NextContinuationToken;
  } while (continuationToken);

  return keys;
}

// Download a single S3 object to a local file path
export async function downloadS3File(
  bucket: string,
  key: string,
  destPath: string,
  credentials: { keyId: string; secret: string; token?: string },
  region: string,
): Promise<void> {
  const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { pipeline } = await import("stream/promises");
  const { createWriteStream } = await import("fs");

  const client = new S3Client({
    region,
    credentials: {
      accessKeyId: credentials.keyId,
      secretAccessKey: credentials.secret,
      sessionToken: credentials.token,
    },
  });

  const resp = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await pipeline(resp.Body as any, createWriteStream(destPath));
}

// Download a folder of part-files into a single local dir and return ONE table entry.
// Table name comes from the last non-empty segment of the S3 prefix.
export async function downloadS3Folder(
  bucket: string,
  prefix: string,
  keys: string[],
  credentials: { keyId: string; secret: string; token?: string },
  region: string,
  progress: vscode.Progress<{ message?: string }>,
): Promise<TableEntry | null> {
  const supportedKeys = keys.filter((k) => detectFileType(k) !== null);
  if (supportedKeys.length === 0) {
    return null;
  }

  // Derive table name from the folder (last path segment, not the part-file names)
  const folderSegment = prefix.replace(/\/$/, "").split("/").pop() ?? "table";
  const tableName = deriveTableName(folderSegment);

  // All part-files in a partition share the same file type; use the first to detect
  const fileType = detectFileType(supportedKeys[0])!;
  const ext = path.extname(supportedKeys[0]); // e.g. ".parquet"

  const tempDir = ensureTempDir();
  const localDir = path.join(tempDir, tableName);
  fs.mkdirSync(localDir, { recursive: true });

  for (const key of supportedKeys) {
    const filename = path.basename(key);
    progress.report({ message: `Downloading ${filename}…` });
    await downloadS3File(
      bucket,
      key,
      path.join(localDir, filename),
      credentials,
      region,
    );
  }

  // DuckDB glob — reads all matching files as one table
  const globPath = path.join(localDir, `*${ext}`);

  return {
    name: tableName,
    filePath: globPath,
    sourceUri: `s3://${bucket}/${prefix}`,
    fileType,
    isS3: true,
  };
}

// Build TableEntry list by downloading individual S3 objects to temp dir (single-file paths)
export async function downloadS3Entries(
  bucket: string,
  keys: string[],
  credentials: { keyId: string; secret: string; token?: string },
  region: string,
  progress: vscode.Progress<{ message?: string }>,
): Promise<TableEntry[]> {
  const tempDir = ensureTempDir();
  const entries: TableEntry[] = [];
  const names = new Set<string>();

  const supportedKeys = keys.filter((k) => detectFileType(k) !== null);

  for (const key of supportedKeys) {
    const fileType = detectFileType(key)!;
    let name = deriveTableName(key);
    let suffix = 1;
    const base = name;
    while (names.has(name)) {
      name = `${base}_${suffix++}`;
    }
    names.add(name);

    const ext = path.extname(key);
    const localPath = path.join(tempDir, `${name}${ext}`);
    const s3Uri = `s3://${bucket}/${key}`;

    progress.report({ message: `Downloading ${path.basename(key)}…` });
    await downloadS3File(bucket, key, localPath, credentials, region);

    entries.push({
      name,
      filePath: localPath, // DuckDB reads from here
      sourceUri: s3Uri, // shown in UI
      fileType,
      isS3: true,
    });
  }

  return entries;
}

// Group S3 keys by their immediate parent prefix (leaf directory).
// Each unique parent prefix becomes one table — mirrors the local scanFolder logic.
export function groupKeysByLeafPrefix(keys: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const key of keys) {
    const dir = key.substring(0, key.lastIndexOf("/") + 1);
    if (!groups.has(dir)) {
      groups.set(dir, []);
    }
    groups.get(dir)!.push(key);
  }
  return groups;
}

export function entryFromS3File(
  s3Uri: string,
): (S3ParseResult & { fileType: ReturnType<typeof detectFileType> }) | null {
  const parsed = parseS3Uri(s3Uri);
  if (!parsed || parsed.isFolder) {
    return null;
  }
  const fileType = detectFileType(parsed.prefix);
  if (!fileType) {
    return null;
  }
  return { ...parsed, fileType };
}

export function getConfig(): {
  profile: string;
  region: string;
  maxRows: number;
} {
  const cfg = vscode.workspace.getConfiguration("fileSql");
  return {
    profile: cfg.get<string>("awsProfile", "default"),
    region: cfg.get<string>("awsRegion", "us-east-1"),
    maxRows: cfg.get<number>("maxResultRows", 1000),
  };
}
