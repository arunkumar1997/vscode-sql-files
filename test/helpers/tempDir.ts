import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface TempDir {
  path: string;
  cleanup: () => void;
}

export function createTempDir(prefix = "file-sql-test-"): TempDir {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    path: dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}
