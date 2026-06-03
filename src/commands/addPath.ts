import * as path from "path";
import * as vscode from "vscode";
import { DuckDBEngine } from "../duckdbEngine";
import { entryFromLocalFile, scanFolder } from "../fileScanner";
import {
  detectBucketRegion,
  downloadS3Entries,
  downloadS3Folder,
  getConfig,
  listS3Keys,
  parseS3Uri,
  resolveAwsCredentials,
} from "../s3Handler";
import { TableRegistry } from "../tableRegistry";
import { TableEntry } from "../types";
import { log, logError } from "../logger";

export async function addPath(
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
          // Folder → one table named after the folder, glob-reads all part files
          const entry = await downloadS3Folder(
            parsed.bucket,
            parsed.prefix,
            keys,
            creds,
            region,
            progress,
          );
          entries = entry ? [entry] : [];
        } else {
          // Single file — key is the prefix without trailing slash
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
      } catch (err: unknown) {
        logError("S3 loading failed", err);
        vscode.window.showErrorMessage(
          `File SQL S3 error: ${(err as Error).message}`,
        );
      }
    },
  );
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
    await registerEntries([entry], registry, engine, { report: () => {} });
    log("Successfully loaded 1 table from local file");
    vscode.window.showInformationMessage("File SQL: Loaded 1 table.");
  }
}

async function registerEntries(
  entries: TableEntry[],
  registry: TableRegistry,
  engine: DuckDBEngine,
  progress: vscode.Progress<{ message?: string }>,
): Promise<void> {
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
