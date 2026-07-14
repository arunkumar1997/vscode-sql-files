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

const HIVE_PARTITION_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*=.+$/;

interface FileGroup {
  fileType: FileType;
  ext: string;
}

interface HivePartitionRoot {
  path: string;
  groups: FileGroup[];
}

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

  const hiveRoots = findHivePartitionRoots(folderPath);
  for (const hiveRoot of hiveRoots) {
    const dirName = path.basename(hiveRoot.path);
    const isSingleGroup = hiveRoot.groups.length === 1;
    for (const { fileType, ext } of hiveRoot.groups) {
      const baseName = isSingleGroup
        ? sanitizeName(dirName)
        : sanitizeName(`${dirName}_${ext.slice(1)}`);
      entries.push({
        name: uniqueName(baseName, names),
        filePath: path.join(hiveRoot.path, "**", `*${ext}`),
        fileType,
        isS3: false,
        hivePartitioning: true,
      });
    }
  }

  for (const [dir, files] of dirMap) {
    if (hiveRoots.some((hiveRoot) => isInsideDirectory(dir, hiveRoot.path))) {
      continue;
    }
    // Group by (fileType, ext) so each distinct extension is one glob pattern.
    const groups = new Map<string, FileGroup>();
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

      const name = uniqueName(baseName, names);

      // DuckDB's read_* functions natively support glob patterns, so passing
      // "/path/to/dir/*.parquet" reads all matching files as one table.
      const globPath = path.join(dir, `*${ext}`);
      entries.push({ name, filePath: globPath, fileType, isS3: false });
    }
  }

  return entries;
}

/**
 * Find top-level folders whose supported files are stored below one or more
 * Hive-style key=value directory segments. Nested roots are omitted when their
 * ancestor is already a valid Hive dataset.
 */
function findHivePartitionRoots(folderPath: string): HivePartitionRoot[] {
  const candidates: HivePartitionRoot[] = [];

  function inspect(candidate: string): void {
    const groups = getHivePartitionFileGroups(candidate);
    if (groups) {
      candidates.push({ path: candidate, groups });
      return;
    }

    let items: string[];
    try {
      items = fs.readdirSync(candidate);
    } catch {
      return;
    }
    for (const item of items) {
      if (item.startsWith(".")) {
        continue;
      }
      const child = path.join(candidate, item);
      try {
        if (fs.statSync(child).isDirectory()) {
          inspect(child);
        }
      } catch {
        // Ignore entries that disappear or cannot be read while scanning.
      }
    }
  }

  inspect(folderPath);
  return candidates;
}

function getHivePartitionFileGroups(root: string): FileGroup[] | null {
  let valid = true;
  const groups = new Map<string, FileGroup>();

  function walkHive(dir: string, partitionDepth: number): void {
    let items: string[];
    try {
      items = fs.readdirSync(dir);
    } catch {
      valid = false;
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
        valid = false;
        continue;
      }

      if (stat.isDirectory()) {
        if (!HIVE_PARTITION_SEGMENT.test(item)) {
          valid = false;
          continue;
        }
        walkHive(full, partitionDepth + 1);
      } else {
        const fileType = SUPPORTED_EXTENSIONS[path.extname(full).toLowerCase()];
        if (!fileType) {
          continue;
        }
        if (partitionDepth === 0) {
          valid = false;
          continue;
        }
        const ext = path.extname(full).toLowerCase();
        groups.set(`${fileType}:${ext}`, { fileType, ext });
      }
    }
  }

  walkHive(root, 0);
  return valid && groups.size > 0 ? Array.from(groups.values()) : null;
}

function isInsideDirectory(dir: string, parent: string): boolean {
  const relative = path.relative(parent, dir);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function uniqueName(baseName: string, names: Set<string>): string {
  let name = baseName;
  let suffix = 1;
  while (names.has(name)) {
    name = `${baseName}_${suffix++}`;
  }
  names.add(name);
  return name;
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
