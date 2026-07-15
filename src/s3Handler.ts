import { fromIni } from "@aws-sdk/credential-providers";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { FileType, TableEntry } from "./types";
import { detectFileType, deriveTableName } from "./fileScanner";

interface S3ParseResult {
  bucket: string;
  prefix: string;
  isFolder: boolean;
}

export interface S3FileGroup {
  fileType: FileType;
  ext: string;
  keys: string[];
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
    } catch {
      // Temp cleanup is best-effort during extension shutdown.
    }
    _tempDir = undefined;
  }
}

/**
 * Create a unique per-load temp directory for S3 downloads.
 * Uses random IDs only (never table names) to avoid path-injection.
 * Returns the path. Caller owns cleanup (on failure, cancel, or unload).
 */
export function createPerLoadTempDir(): string {
  const base = ensureTempDir();
  return fs.mkdtempSync(path.join(base, "load-"));
}

/**
 * Cleanup a specific per-load temp directory.
 * Best-effort — swallows errors. Safe to call on non-existent paths.
 * Only deletes paths that are children of the session temp root.
 */
export function cleanupPerLoadTempDir(tempPath: string): void {
  if (!tempPath || !_tempDir) {
    return;
  }
  // Safety: only delete paths that are proper children of our session temp dir
  const resolved = path.resolve(tempPath);
  const root = path.resolve(_tempDir);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    return;
  }
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
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
  abortSignal?: AbortSignal,
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
    { abortSignal },
  );
  // LocationConstraint is null/undefined for us-east-1 buckets
  return resp.LocationConstraint ?? "us-east-1";
}

export async function listS3Keys(
  bucket: string,
  prefix: string,
  region: string,
  credentials: { keyId: string; secret: string; token?: string },
  abortSignal?: AbortSignal,
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
    if (abortSignal?.aborted) {
      throw new Error("Cancelled");
    }
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
      { abortSignal },
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
  abortSignal?: AbortSignal,
): Promise<void> {
  const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { pipeline } = await import("stream/promises");
  const { createWriteStream } = await import("fs");

  if (abortSignal?.aborted) {
    throw new Error("Cancelled");
  }

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
    { abortSignal },
  );
  const pipelineArgs: [any, any, ...any[]] = [resp.Body as any, createWriteStream(destPath)];
  if (abortSignal) {
    pipelineArgs.push({ signal: abortSignal });
  }
  await pipeline(...pipelineArgs);
}

/**
 * Validate that a resolved destination path stays inside the intended base directory.
 * Prevents directory traversal attacks from malicious S3 object keys.
 */
function assertContainedPath(base: string, destination: string, key: string): void {
  const resolvedBase = path.resolve(base);
  const resolvedDest = path.resolve(destination);
  if (!resolvedDest.startsWith(resolvedBase + path.sep) && resolvedDest !== resolvedBase) {
    throw new Error(`S3 key "${key}" resolves outside temp directory (path traversal rejected)`);
  }
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

  const localDir = createPerLoadTempDir();

  try {
    for (const key of supportedKeys) {
      const filename = path.basename(key);
      const destPath = path.join(localDir, filename);
      assertContainedPath(localDir, destPath, key);
      progress.report({ message: `Downloading ${filename}…` });
      await downloadS3File(
        bucket,
        key,
        destPath,
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
  } catch (err) {
    cleanupPerLoadTempDir(localDir);
    throw err;
  }
}

/**
 * Download a Hive-style dataset without flattening its key=value
 * directory structure, then register it as one partitioned table.
 */
export async function downloadS3HiveFolder(
  bucket: string,
  prefix: string,
  keys: string[],
  credentials: { keyId: string; secret: string; token?: string },
  region: string,
  progress: vscode.Progress<{ message?: string }>,
  fileType: FileType,
  ext: string,
  includeExtensionInName: boolean,
): Promise<TableEntry | null> {
  if (keys.length === 0) {
    return null;
  }

  const folderSegment = prefix.replace(/\/$/, "").split("/").pop() ?? "table";
  const tableName = deriveTableName(
    includeExtensionInName ? `${folderSegment}_${ext.slice(1)}` : folderSegment,
  );
  const localDir = createPerLoadTempDir();

  try {
    for (const key of keys) {
      const relativePath = key.slice(prefix.length);
      const parts = relativePath.split("/");
      if (!relativePath || parts.some((part) => part === "" || part === "." || part === "..")) {
        throw new Error(`Invalid object key for Hive dataset: ${key}`);
      }

      const destination = path.join(localDir, ...parts);
      assertContainedPath(localDir, destination, key);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      progress.report({ message: `Downloading ${path.basename(key)}…` });
      await downloadS3File(bucket, key, destination, credentials, region);
    }

    return {
      name: tableName,
      filePath: path.join(localDir, "**", `*${ext}`),
      sourceUri: `s3://${bucket}/${prefix}`,
      fileType,
      isS3: true,
      hivePartitioning: true,
    };
  } catch (err) {
    cleanupPerLoadTempDir(localDir);
    throw err;
  }
}

// Build TableEntry list by downloading individual S3 objects to temp dir (single-file paths)
export async function downloadS3Entries(
  bucket: string,
  keys: string[],
  credentials: { keyId: string; secret: string; token?: string },
  region: string,
  progress: vscode.Progress<{ message?: string }>,
): Promise<TableEntry[]> {
  const localDir = createPerLoadTempDir();
  const entries: TableEntry[] = [];
  const names = new Set<string>();

  const supportedKeys = keys.filter((k) => detectFileType(k) !== null);

  try {
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
      const localPath = path.join(localDir, `${name}${ext}`);
      assertContainedPath(localDir, localPath, key);
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
  } catch (err) {
    cleanupPerLoadTempDir(localDir);
    throw err;
  }
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

/** Group supported S3 files by reader type and extension. */
export function groupS3KeysByFileType(keys: string[]): S3FileGroup[] {
  const groups = new Map<string, S3FileGroup>();
  for (const key of keys) {
    const fileType = detectFileType(key);
    if (!fileType) {
      continue;
    }
    const ext = path.extname(key);
    const groupKey = `${fileType}:${ext.toLowerCase()}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, { fileType, ext, keys: [] });
    }
    groups.get(groupKey)!.keys.push(key);
  }
  return Array.from(groups.values());
}

/**
 * Find the highest S3 prefixes that contain supported files below one or more
 * Hive-style key=value directory levels. The returned prefixes are disjoint,
 * so each file-type group becomes one table.
 */
export function findHivePartitionPrefixes(
  keys: string[],
  rootPrefix: string,
): string[] {
  const normalizedRoot = rootPrefix === "" || rootPrefix.endsWith("/")
    ? rootPrefix
    : `${rootPrefix}/`;
  const candidates = new Set<string>([normalizedRoot]);

  for (const key of keys) {
    let directory = key.slice(0, key.lastIndexOf("/") + 1);
    while (directory.startsWith(normalizedRoot)) {
      candidates.add(directory);
      if (directory === normalizedRoot) {
        break;
      }
      directory = directory.slice(0, directory.slice(0, -1).lastIndexOf("/") + 1);
    }
  }

  const hivePrefixes = Array.from(candidates).filter((candidate) =>
    isHivePartitionedS3Prefix(candidate, keys),
  );

  return hivePrefixes.filter(
    (candidate) =>
      !hivePrefixes.some(
        (ancestor) => ancestor !== candidate && candidate.startsWith(ancestor),
      ),
  );
}

function isHivePartitionedS3Prefix(prefix: string, keys: string[]): boolean {
  const dataKeys = keys.filter((key) =>
    key.startsWith(prefix) && detectFileType(key) !== null,
  );
  if (dataKeys.length === 0) {
    return false;
  }

  return dataKeys.every((key) => {
    const pathParts = key.slice(prefix.length).split("/");
    const directories = pathParts.slice(0, -1);
    return directories.length > 0 && directories.every((part) =>
      /^[A-Za-z_][A-Za-z0-9_]*=.+$/.test(part),
    );
  });
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
