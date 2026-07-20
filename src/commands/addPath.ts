import * as path from "path";
import * as vscode from "vscode";
import { isQueryEditorOpen } from "./openQueryEditor";
import { DuckDBEngine } from "../duckdbEngine";
import { entryFromLocalFile, scanFolder } from "../fileScanner";
import {
  detectBucketRegion,
  downloadS3Entries,
  downloadS3Folder,
  downloadS3HiveFolder,
  findHivePartitionPrefixes,
  getConfig,
  groupKeysByLeafPrefix,
  groupS3KeysByFileType,
  isSingleKeyRangeEligible,
  listS3Keys,
  parseS3Uri,
  rangeReadKeys,
  resolveAwsCredentials,
} from "../s3Handler";
import { resolveS3ReadMode, registerWithRangeRead } from "../s3RangeRead";
import { TableRegistry } from "../tableRegistry";
import { TableEntry } from "../types";
import { log, logError } from "../logger";

export async function addPath(
  registry: TableRegistry,
  engine: DuckDBEngine,
): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: "$(edit) Enter Path",
        description: "Type a local file/folder path or s3:// URI",
        id: "enter",
      },
      {
        label: "$(file) Browse File",
        description: "Pick a file from your filesystem",
        id: "file",
      },
    ],
    {
      placeHolder: "How would you like to add a data source?",
    },
  );

  if (!pick) {
    return;
  }

  switch (pick.id) {
    case "enter":
      await handleEnterPath(registry, engine);
      break;
    case "file":
      await handleBrowseFile(registry, engine);
      break;
  }
}

async function handleEnterPath(
  registry: TableRegistry,
  engine: DuckDBEngine,
): Promise<void> {
  const input = await vscode.window.showInputBox({
    prompt: "Enter a local file/folder path or s3:// URI",
    placeHolder: "/path/to/file.csv  OR  s3://bucket/prefix/",
  });
  if (!input) {
    return;
  }

  const trimmed = input.trim();
  log(`User requested to add path: ${trimmed}`);
  if (trimmed.startsWith("s3://")) {
    await handleS3Path(trimmed, registry, engine);
  } else {
    await handleLocalPath(trimmed, registry, engine);
  }
}

async function handleBrowseFile(
  registry: TableRegistry,
  engine: DuckDBEngine,
): Promise<void> {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: true,
    openLabel: "Load File",
    filters: {
      "Supported Data Files": [
        "csv",
        "tsv",
        "json",
        "jsonl",
        "ndjson",
        "parquet",
        "txt",
        "log",
      ],
      "CSV / TSV": ["csv", "tsv"],
      JSON: ["json", "jsonl", "ndjson"],
      Parquet: ["parquet"],
      "Text / Log": ["txt", "log"],
      "All Files": ["*"],
    },
  });

  if (!uris || uris.length === 0) {
    return;
  }

  log(`User browsed ${uris.length} file(s)`);
  const entries: TableEntry[] = [];
  for (const uri of uris) {
    const filePath = uri.fsPath;
    const entry = entryFromLocalFile(filePath);
    if (entry) {
      entries.push(entry);
    } else {
      log(`Skipping unsupported file: ${filePath}`);
      vscode.window.showWarningMessage(
        `Unsupported file type: ${path.extname(filePath)}`,
      );
    }
  }

  if (entries.length === 0) {
    vscode.window.showWarningMessage("No supported files selected.");
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "File SQL: Loading file(s)…",
    },
    async (progress) => {
      await registerEntries(entries, registry, engine, progress);
      log(`Successfully loaded ${entries.length} table(s) via file browser`);
      vscode.window.showInformationMessage(
        `File SQL: Loaded ${entries.length} table(s).`,
      );
      if (!isQueryEditorOpen()) {
        vscode.commands.executeCommand("fileSql.openQueryEditor");
      }
    },
  );
}

async function handleS3Path(
  uri: string,
  registry: TableRegistry,
  engine: DuckDBEngine,
): Promise<void> {
  const parsed = parseS3Uri(uri);
  if (!parsed) {
    log(`Invalid S3 URI provided: ${uri}`);
    vscode.window.showErrorMessage(`Invalid S3 URI: ${uri}`);
    return;
  }

  const { profile } = getConfig();

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "File SQL: Loading S3 path…",
      cancellable: false,
    },
    async (progress) => {
      try {
        log(
          `Loading S3 path: bucket=${parsed.bucket}, prefix=${parsed.prefix}`,
        );
        progress.report({ message: "Resolving credentials…" });
        const creds = await resolveAwsCredentials(profile);

        progress.report({ message: "Detecting bucket region…" });
        const region = await detectBucketRegion(parsed.bucket, creds);
        log(`Detected region: ${region}`);

        let entries: TableEntry[];

        if (parsed.isFolder) {
          progress.report({ message: "Listing objects…" });
          const keys = await listS3Keys(
            parsed.bucket,
            parsed.prefix,
            region,
            creds,
          );
          log(`Found ${keys.length} object(s) at S3 path`);
          if (keys.length === 0) {
            vscode.window.showWarningMessage(
              "No supported files found at that S3 path.",
            );
            return;
          }

          // Check range-read eligibility for the whole folder
          const parquetKeys = rangeReadKeys(keys);
          const allParquet = parquetKeys.length > 0;
          const readMode = await resolveS3ReadMode(keys);
          if (readMode === undefined) {
            return; // User cancelled
          }

          if (readMode === "range" && allParquet) {
            // Range-read path for all-Parquet folder
            await handleS3FolderRangeRead(
              parsed, parquetKeys, creds, region, registry, engine, progress,
            );
            return;
          }

          // Download path (original behavior)
          entries = [];
          const hivePrefixes = findHivePartitionPrefixes(keys, parsed.prefix);
          const hiveKeys = new Set<string>();
          for (const hivePrefix of hivePrefixes) {
            const partitionKeys = keys.filter((key) => key.startsWith(hivePrefix));
            partitionKeys.forEach((key) => hiveKeys.add(key));
            const fileGroups = groupS3KeysByFileType(partitionKeys);
            const includeExtensionInName = fileGroups.length > 1;
            for (const group of fileGroups) {
              const entry = await downloadS3HiveFolder(
                parsed.bucket,
                hivePrefix,
                group.keys,
                creds,
                region,
                progress,
                group.fileType,
                group.ext,
                includeExtensionInName,
              );
              if (entry) {
                entries.push(entry);
              }
            }
          }

          // Non-Hive data keeps the existing leaf-folder grouping behaviour.
          const leafGroups = groupKeysByLeafPrefix(
            keys.filter((key) => !hiveKeys.has(key)),
          );
          for (const [leafPrefix, leafKeys] of leafGroups) {
            const entry = await downloadS3Folder(
              parsed.bucket,
              leafPrefix,
              leafKeys,
              creds,
              region,
              progress,
            );
            if (entry) {
              entries.push(entry);
            }
          }
          makeEntryNamesUnique(entries);
        } else {
          // Single file
          const key = parsed.prefix;
          const readMode = await resolveS3ReadMode([key]);
          if (readMode === undefined) {
            return; // User cancelled
          }

          if (readMode === "range" && isSingleKeyRangeEligible(key)) {
            await handleS3SingleFileRangeRead(
              parsed, key, creds, region, registry, engine, progress,
            );
            return;
          }

          // Download path
          entries = await downloadS3Entries(
            parsed.bucket,
            [parsed.prefix],
            creds,
            region,
            progress,
          );
        }

        if (entries.length === 0) {
          vscode.window.showWarningMessage(
            "No supported files found at that S3 path.",
          );
          return;
        }

        await registerEntries(entries, registry, engine, progress);
        log(`Successfully loaded ${entries.length} table(s) from S3`);
        vscode.window.showInformationMessage(
          `File SQL: Loaded ${entries.length} table(s) from S3 (${parsed.bucket}).`,
        );
        if (!isQueryEditorOpen()) {
          vscode.commands.executeCommand("fileSql.openQueryEditor");
        }
      } catch (err: unknown) {
        logError("S3 loading failed", err);
        vscode.window.showErrorMessage(
          `File SQL S3 error: ${(err as Error).message}`,
        );
      }
    },
  );
}

/**
 * Handle range-read registration for a single S3 Parquet file.
 */
async function handleS3SingleFileRangeRead(
  parsed: { bucket: string; prefix: string },
  key: string,
  creds: { keyId: string; secret: string; token?: string },
  region: string,
  registry: TableRegistry,
  engine: DuckDBEngine,
  progress: vscode.Progress<{ message?: string }>,
): Promise<void> {
  const { deriveTableName } = await import("../fileScanner");
  const tableName = deriveTableName(key);
  const entry: TableEntry = {
    name: tableName,
    filePath: `s3://${parsed.bucket}/${key}`,
    sourceUri: `s3://${parsed.bucket}/${key}`,
    fileType: "parquet",
    isS3: true,
  };

  try {
    await engine.ensureInitialized();
  } catch (err: unknown) {
    vscode.window.showErrorMessage(
      `File SQL: DuckDB failed to initialize — ${(err as Error).message}`,
    );
    return;
  }

  const result = await registerWithRangeRead(
    entry, parsed.bucket, key, [key], creds, region, engine, registry, progress,
  );

  if (result === "registered") {
    registry.add(entry);
    vscode.window.showInformationMessage(
      `File SQL: Loaded "${tableName}" via range-read from S3.`,
    );
    if (!isQueryEditorOpen()) {
      vscode.commands.executeCommand("fileSql.openQueryEditor");
    }
  } else if (result === "fallback") {
    // Fallback to download
    const entries = await downloadS3Entries(
      parsed.bucket, [key], creds, region, progress,
    );
    if (entries.length > 0) {
      await registerEntries(entries, registry, engine, progress);
      vscode.window.showInformationMessage(
        `File SQL: Loaded "${entries[0].name}" (downloaded from S3).`,
      );
      if (!isQueryEditorOpen()) {
        vscode.commands.executeCommand("fileSql.openQueryEditor");
      }
    }
  }
  // "cancelled" — do nothing
}

/**
 * Handle range-read registration for an all-Parquet S3 folder.
 */
async function handleS3FolderRangeRead(
  parsed: { bucket: string; prefix: string },
  keys: string[],
  creds: { keyId: string; secret: string; token?: string },
  region: string,
  registry: TableRegistry,
  engine: DuckDBEngine,
  progress: vscode.Progress<{ message?: string }>,
): Promise<void> {
  const { deriveTableName } = await import("../fileScanner");

  try {
    await engine.ensureInitialized();
  } catch (err: unknown) {
    vscode.window.showErrorMessage(
      `File SQL: DuckDB failed to initialize — ${(err as Error).message}`,
    );
    return;
  }

  // Check for Hive partitioning
  const hivePrefixes = findHivePartitionPrefixes(keys, parsed.prefix);
  const hiveKeys = new Set<string>();
  for (const hp of hivePrefixes) {
    keys.filter((k) => k.startsWith(hp)).forEach((k) => hiveKeys.add(k));
  }

  const registeredEntries: TableEntry[] = [];

  // Register Hive-partitioned groups via range-read
  for (const hivePrefix of hivePrefixes) {
    const partitionKeys = keys.filter((k) => k.startsWith(hivePrefix));
    const folderSegment = hivePrefix.replace(/\/$/, "").split("/").pop() ?? "table";
    const tableName = deriveTableName(folderSegment);
    const entry: TableEntry = {
      name: tableName,
      filePath: `s3://${parsed.bucket}/${hivePrefix}`,
      sourceUri: `s3://${parsed.bucket}/${hivePrefix}`,
      fileType: "parquet",
      isS3: true,
      hivePartitioning: true,
    };

    const result = await registerWithRangeRead(
      entry, parsed.bucket, hivePrefix, partitionKeys, creds, region, engine, registry, progress,
    );

    if (result === "registered") {
      registry.add(entry);
      registeredEntries.push(entry);
    } else if (result === "fallback") {
      // Download fallback for this group
      const downloaded = await downloadS3HiveFolder(
        parsed.bucket, hivePrefix, partitionKeys, creds, region, progress, "parquet", ".parquet", false,
      );
      if (downloaded) {
        await registerEntries([downloaded], registry, engine, progress);
        registeredEntries.push(downloaded);
      }
    }
  }

  // Non-Hive leaf groups
  const nonHiveKeys = keys.filter((k) => !hiveKeys.has(k));
  const leafGroups = groupKeysByLeafPrefix(nonHiveKeys);
  for (const [leafPrefix, leafKeys] of leafGroups) {
    const folderSegment = leafPrefix.replace(/\/$/, "").split("/").pop() ?? "table";
    const tableName = deriveTableName(folderSegment);
    const entry: TableEntry = {
      name: tableName,
      filePath: `s3://${parsed.bucket}/${leafPrefix}`,
      sourceUri: `s3://${parsed.bucket}/${leafPrefix}`,
      fileType: "parquet",
      isS3: true,
    };

    const result = await registerWithRangeRead(
      entry, parsed.bucket, leafPrefix, leafKeys, creds, region, engine, registry, progress,
    );

    if (result === "registered") {
      registry.add(entry);
      registeredEntries.push(entry);
    } else if (result === "fallback") {
      const downloaded = await downloadS3Folder(
        parsed.bucket, leafPrefix, leafKeys, creds, region, progress,
      );
      if (downloaded) {
        await registerEntries([downloaded], registry, engine, progress);
        registeredEntries.push(downloaded);
      }
    }
  }

  if (registeredEntries.length > 0) {
    makeEntryNamesUnique(registeredEntries);
    vscode.window.showInformationMessage(
      `File SQL: Loaded ${registeredEntries.length} table(s) from S3 (${parsed.bucket}).`,
    );
    if (!isQueryEditorOpen()) {
      vscode.commands.executeCommand("fileSql.openQueryEditor");
    }
  } else {
    vscode.window.showWarningMessage(
      "No tables loaded from S3 — all cancelled or failed.",
    );
  }
}

function makeEntryNamesUnique(entries: TableEntry[]): void {
  const names = new Set<string>();
  for (const entry of entries) {
    const baseName = entry.name;
    let name = baseName;
    let suffix = 1;
    while (names.has(name)) {
      name = `${baseName}_${suffix++}`;
    }
    names.add(name);
    entry.name = name;
  }
}

async function handleLocalPath(
  inputPath: string,
  registry: TableRegistry,
  engine: DuckDBEngine,
): Promise<void> {
  const { promises: fsp } = await import("fs");
  let stat;
  try {
    stat = await fsp.stat(inputPath);
  } catch {
    log(`Path not found: ${inputPath}`);
    vscode.window.showErrorMessage(`Path not found: ${inputPath}`);
    return;
  }

  if (stat.isDirectory()) {
    log(`Loading local folder: ${inputPath}`);
    const entries = scanFolder(inputPath);
    if (entries.length === 0) {
      vscode.window.showWarningMessage(
        "No supported files found in that folder.",
      );
      return;
    }
    log(`Found ${entries.length} supported file(s) in folder`);
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "File SQL: Loading folder…",
      },
      async (progress) => {
        await registerEntries(entries, registry, engine, progress);
        log(`Successfully loaded ${entries.length} table(s) from local folder`);
        vscode.window.showInformationMessage(
          `File SQL: Loaded ${entries.length} table(s).`,
        );
        if (!isQueryEditorOpen()) {
          vscode.commands.executeCommand("fileSql.openQueryEditor");
        }
      },
    );
  } else {
    log(`Loading local file: ${inputPath}`);
    const entry = entryFromLocalFile(inputPath);
    if (!entry) {
      log(`Unsupported file type: ${path.extname(inputPath)}`);
      vscode.window.showErrorMessage(
        `Unsupported file type: ${path.extname(inputPath)}`,
      );
      return;
    }
    await registerEntries([entry], registry, engine, { report: () => { } });
    log("Successfully loaded 1 table from local file");
    vscode.window.showInformationMessage("File SQL: Loaded 1 table.");
    if (!isQueryEditorOpen()) {
      vscode.commands.executeCommand("fileSql.openQueryEditor");
    }
  }
}

async function registerEntries(
  entries: TableEntry[],
  registry: TableRegistry,
  engine: DuckDBEngine,
  progress: vscode.Progress<{ message?: string }>,
): Promise<void> {
  try {
    await engine.ensureInitialized();
  } catch (err: unknown) {
    vscode.window.showErrorMessage(
      `File SQL: DuckDB failed to initialize — ${(err as Error).message}`,
    );
    return;
  }
  for (const entry of entries) {
    progress.report({ message: `Registering ${entry.name}…` });
    try {
      const cols = await engine.registerTable(entry);
      entry.columns = cols;
      registry.add(entry);
      log(`Successfully registered table: ${entry.name}`);
    } catch (err: unknown) {
      logError(`Failed to load table ${entry.name}`, err);
      vscode.window.showErrorMessage(
        `Failed to load ${entry.name}: ${(err as Error).message}`,
      );
    }
  }
}
