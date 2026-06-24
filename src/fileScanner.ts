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

function sanitizeName(name: string): string {
  const sanitized = name
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/^([0-9])/, "_$1");
  return sanitized || "table";
}

export function scanFolder(folderPath: string): TableEntry[] {
  // Group files by their immediate parent directory.
  // Each directory containing data files becomes one table (named after
  // that directory). Multiple file-extension groups within one directory
  // produce separate tables suffixed with the extension name.
  const dirMap = new Map<
    string,
    Array<{ filePath: string; fileType: FileType; ext: string }>
  >();

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
        const ext = path.extname(full).toLowerCase();
        const fileType = SUPPORTED_EXTENSIONS[ext] ?? null;
        if (!fileType) {
          continue;
        }
        if (!dirMap.has(dir)) {
          dirMap.set(dir, []);
        }
        dirMap.get(dir)!.push({ filePath: full, fileType, ext });
      }
    }
  }

  walk(folderPath);

  const entries: TableEntry[] = [];
  const names = new Set<string>();

  for (const [dir, files] of dirMap) {
    // Group by (fileType, ext) so each distinct extension is one glob pattern.
    const groups = new Map<string, { fileType: FileType; ext: string }>();
    for (const { fileType, ext } of files) {
      const key = `${fileType}:${ext}`;
      if (!groups.has(key)) {
        groups.set(key, { fileType, ext });
      }
    }

    const dirName = path.basename(dir);
    const isSingleGroup = groups.size === 1;

    for (const { fileType, ext } of groups.values()) {
      // Table name = directory name when all files share one type,
      // or directory + extension suffix when there are multiple types.
      const baseName = isSingleGroup
        ? sanitizeName(dirName)
        : sanitizeName(`${dirName}_${ext.slice(1)}`);

      let name = baseName;
      let suffix = 1;
      while (names.has(name)) {
        name = `${baseName}_${suffix++}`;
      }
      names.add(name);

      // DuckDB's read_* functions natively support glob patterns, so passing
      // "/path/to/dir/*.parquet" reads all matching files as one table.
      const globPath = path.join(dir, `*${ext}`);
      entries.push({ name, filePath: globPath, fileType, isS3: false });
    }
  }

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
