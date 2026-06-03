import * as fs from "fs";
import * as path from "path";
import { FileType, TableEntry } from "./types";

const SUPPORTED_EXTENSIONS: Record<string, FileType> = {
  ".csv": "csv",
  ".tsv": "csv",
  ".json": "json",
  ".jsonl": "json",
  ".ndjson": "json",
  ".parquet": "parquet",
  ".txt": "text",
  ".log": "text",
};

export function detectFileType(filePath: string): FileType | null {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS[ext] ?? null;
}

export function deriveTableName(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath));
  // Replace non-alphanumeric chars with underscores; ensure starts with letter
  const sanitized = base
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/^([0-9])/, "_$1");
  return sanitized || "table";
}

export function scanFolder(folderPath: string): TableEntry[] {
  const entries: TableEntry[] = [];
  const names = new Set<string>();

  function walk(dir: string): void {
    let items: string[];
    try {
      items = fs.readdirSync(dir);
    } catch {
      return;
    }

    for (const item of items) {
      if (item.startsWith(".")) {
        continue;
      }
      const full = path.join(dir, item);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(full);
      } else {
        const fileType = detectFileType(full);
        if (!fileType) {
          continue;
        }
        let name = deriveTableName(full);
        // De-duplicate names
        let suffix = 1;
        const base = name;
        while (names.has(name)) {
          name = `${base}_${suffix++}`;
        }
        names.add(name);
        entries.push({ name, filePath: full, fileType, isS3: false });
      }
    }
  }

  walk(folderPath);
  return entries;
}

export function entryFromLocalFile(filePath: string): TableEntry | null {
  const fileType = detectFileType(filePath);
  if (!fileType) {
    return null;
  }
  return {
    name: deriveTableName(filePath),
    filePath,
    fileType,
    isS3: false,
  };
}
