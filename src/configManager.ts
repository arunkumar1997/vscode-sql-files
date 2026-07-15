import * as vscode from "vscode";
import * as crypto from "crypto";
import { ConfigTableEntry, FileType, TableEntry } from "./types";
import { logWarn, logError } from "./logger";

/** Directory and filename for workspace config. */
const CONFIG_DIR = ".filesql";
const CONFIG_FILE = "config.json";
const CURRENT_VERSION = 1;

/** Validated config file shape. */
interface ConfigFileContent {
    version: number;
    tables: ConfigTableEntry[];
}

// --- Validation helpers (no external deps) ---

const VALID_FILE_TYPES: readonly string[] = ["csv", "json", "parquet", "text"];

/** Only these top-level properties are allowed on a table entry in config. */
const APPROVED_TABLE_FIELDS: ReadonlySet<string> = new Set([
    "name",
    "source",
    "fileType",
    "hivePartitioning",
]);

/** Properties that indicate credential or runtime state leakage. */
const FORBIDDEN_FIELDS: ReadonlySet<string> = new Set([
    "filePath",
    "isS3",
    "sourceUri",
    "columns",
    "loadState",
    "loadError",
    "origin",
    "accessKeyId",
    "secretAccessKey",
    "sessionToken",
    "password",
    "token",
    "credentials",
]);

function isNonEmptyString(v: unknown): v is string {
    return typeof v === "string" && v.trim().length > 0;
}

function isValidFileType(v: unknown): v is FileType {
    return typeof v === "string" && VALID_FILE_TYPES.includes(v);
}

/**
 * Strictly parse and validate an s3:// URI.
 * Rejects: whitespace-only bucket, userinfo/credential forms, query, fragment.
 * Preserves trailing-slash semantics.
 */
export function parseS3Uri(uri: string): { bucket: string; key: string } | null {
    if (!uri.startsWith("s3://")) {
        return null;
    }
    const rest = uri.slice(5); // after s3://
    if (rest.length === 0) {
        return null;
    }
    // Reject userinfo forms (user:pass@bucket or user@bucket)
    if (rest.includes("@")) {
        return null;
    }
    // Reject query strings
    if (rest.includes("?")) {
        return null;
    }
    // Reject fragments
    if (rest.includes("#")) {
        return null;
    }
    // Split bucket/key on first /
    const slashIdx = rest.indexOf("/");
    const bucket = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
    const key = slashIdx === -1 ? "" : rest.slice(slashIdx + 1);
    // Reject whitespace-only bucket
    if (bucket.trim().length === 0) {
        return null;
    }
    // Reject bucket with whitespace characters
    if (/\s/.test(bucket)) {
        return null;
    }
    return { bucket, key };
}

/**
 * Validate a source path/URI for config portability.
 * Rejects: absolute paths, UNC paths, device paths, backslashes, workspace traversal.
 * Allows: relative local paths (posix-style) and s3:// URIs.
 * Preserves S3 trailing-slash semantics — does not strip or enforce.
 */
export function isValidSource(v: unknown): v is string {
    if (!isNonEmptyString(v)) {
        return false;
    }
    // S3 URI: strictly parse bucket/key
    if (v.startsWith("s3://")) {
        return parseS3Uri(v) !== null;
    }
    // Reject backslashes (force posix-style)
    if (v.includes("\\")) {
        return false;
    }
    // Reject absolute posix paths
    if (v.startsWith("/")) {
        return false;
    }
    // Reject UNC paths (//server/share)
    if (v.startsWith("//")) {
        return false;
    }
    // Reject Windows-style absolute/device paths: C:, D:\, etc.
    if (/^[A-Za-z]:/.test(v)) {
        return false;
    }
    // Reject workspace traversal (../ anywhere in path)
    // Normalize: split on '/' and check for '..' segments
    const segments = v.split("/");
    for (const seg of segments) {
        if (seg === "..") {
            return false;
        }
    }
    return true;
}

export interface ConfigDiagnostic {
    message: string;
    index?: number; // table index, if applicable
}

/**
 * Validate a single table entry from config JSON.
 * Returns diagnostics (empty = valid).
 * Rejects unknown, credential, and runtime properties.
 */
function validateTableEntry(raw: unknown, index: number): ConfigDiagnostic[] {
    const diags: ConfigDiagnostic[] = [];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        diags.push({ message: `tables[${index}]: expected an object`, index });
        return diags;
    }
    const obj = raw as Record<string, unknown>;

    // Check for forbidden/unknown properties
    for (const key of Object.keys(obj)) {
        if (FORBIDDEN_FIELDS.has(key)) {
            diags.push({
                message: `tables[${index}].${key}: forbidden property (credential or runtime state)`,
                index,
            });
        } else if (!APPROVED_TABLE_FIELDS.has(key)) {
            diags.push({
                message: `tables[${index}].${key}: unknown property (allowed: ${[...APPROVED_TABLE_FIELDS].join(", ")})`,
                index,
            });
        }
    }

    // Normalize name and source BEFORE validation so whitespace cannot bypass safety checks
    const name = typeof obj.name === "string" ? obj.name.trim() : obj.name;
    const source = typeof obj.source === "string" ? obj.source.trim() : obj.source;

    if (!isNonEmptyString(name)) {
        diags.push({ message: `tables[${index}].name: must be a non-empty string`, index });
    }
    if (!isValidSource(source)) {
        diags.push({
            message: `tables[${index}].source: must be a workspace-relative path (posix, no ..) or s3:// URI (got ${JSON.stringify(obj.source)})`,
            index,
        });
    }
    if (!isValidFileType(obj.fileType)) {
        diags.push({
            message: `tables[${index}].fileType: must be one of ${VALID_FILE_TYPES.join(", ")} (got ${JSON.stringify(obj.fileType)})`,
            index,
        });
    }
    if (obj.hivePartitioning !== undefined && typeof obj.hivePartitioning !== "boolean") {
        diags.push({ message: `tables[${index}].hivePartitioning: must be a boolean if present`, index });
    }
    return diags;
}

/**
 * Parse and validate config JSON content.
 * STRICT: fails the entire config if any row is invalid, has duplicates,
 * or contains unknown/forbidden properties. Returns zero entries + all diagnostics.
 * Never throws.
 */
export function parseAndValidateConfig(content: string): {
    entries: ConfigTableEntry[];
    diagnostics: ConfigDiagnostic[];
} {
    const diagnostics: ConfigDiagnostic[] = [];

    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch (e) {
        diagnostics.push({ message: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` });
        return { entries: [], diagnostics };
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        diagnostics.push({ message: "Config must be a JSON object with 'version' and 'tables' fields" });
        return { entries: [], diagnostics };
    }

    const obj = parsed as Record<string, unknown>;

    if (obj.version !== CURRENT_VERSION) {
        diagnostics.push({
            message: `Unsupported config version: ${JSON.stringify(obj.version)} (expected ${CURRENT_VERSION})`,
        });
        return { entries: [], diagnostics };
    }

    if (!Array.isArray(obj.tables)) {
        diagnostics.push({ message: "'tables' must be an array" });
        return { entries: [], diagnostics };
    }

    // Check for unknown top-level keys
    const APPROVED_TOP_LEVEL: ReadonlySet<string> = new Set(["version", "tables"]);
    for (const key of Object.keys(obj)) {
        if (!APPROVED_TOP_LEVEL.has(key)) {
            diagnostics.push({ message: `Unknown top-level property: "${key}"` });
        }
    }

    const entries: ConfigTableEntry[] = [];
    const seenNames = new Set<string>();
    let hasErrors = false;

    for (let i = 0; i < obj.tables.length; i++) {
        const raw = obj.tables[i];
        const entryDiags = validateTableEntry(raw, i);
        if (entryDiags.length > 0) {
            diagnostics.push(...entryDiags);
            hasErrors = true;
            continue;
        }
        const entry = raw as Record<string, unknown>;
        const name = (entry.name as string).trim();
        if (seenNames.has(name)) {
            diagnostics.push({ message: `tables[${i}]: duplicate name "${name}"`, index: i });
            hasErrors = true;
            continue;
        }
        seenNames.add(name);
        entries.push({
            name,
            source: (entry.source as string).trim(),
            fileType: entry.fileType as FileType,
            ...(entry.hivePartitioning === true ? { hivePartitioning: true } : {}),
        });
    }

    // Fail entire config if any row was invalid or duplicated
    if (hasErrors || diagnostics.length > 0) {
        return { entries: [], diagnostics };
    }

    return { entries, diagnostics };
}

/**
 * Build the config file URI from a workspace root.
 */
function configFileUri(workspaceRoot: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(workspaceRoot, CONFIG_DIR, CONFIG_FILE);
}

/** Error subclass for distinguishing missing config file from other read failures. */
export class ConfigReadError extends Error {
    constructor(
        message: string,
        public readonly code: "NOT_FOUND" | "READ_FAILURE",
        public readonly uri: vscode.Uri,
        public readonly cause?: unknown,
    ) {
        super(message);
        this.name = "ConfigReadError";
    }
}

/**
 * Read and validate .filesql/config.json.
 * Returns { entries, diagnostics, missing }.
 * - `missing: true` if the file doesn't exist (not an error).
 * - Throws ConfigReadError for non-ENOENT read failures (permissions, disk errors).
 * - Returns empty entries + diagnostics for malformed/invalid config.
 */
export async function readConfig(workspaceRoot: vscode.Uri): Promise<{
    entries: ConfigTableEntry[];
    diagnostics: ConfigDiagnostic[];
    missing: boolean;
}> {
    const uri = configFileUri(workspaceRoot);
    let content: Uint8Array;
    try {
        content = await vscode.workspace.fs.readFile(uri);
    } catch (err: unknown) {
        // vscode.FileSystemError.FileNotFound has code 'FileNotFound'
        // Also handle generic errors with ENOENT
        if (isFileNotFoundError(err)) {
            return { entries: [], diagnostics: [], missing: true };
        }
        // Non-missing read failure — actionable diagnostic
        const msg = err instanceof Error ? err.message : String(err);
        logError(`[config] Failed to read ${uri.fsPath}`, err);
        throw new ConfigReadError(
            `Failed to read config: ${msg}`,
            "READ_FAILURE",
            uri,
            err,
        );
    }

    const text = Buffer.from(content).toString("utf-8");
    const { entries, diagnostics } = parseAndValidateConfig(text);

    for (const d of diagnostics) {
        logWarn(`[config] ${uri.fsPath}: ${d.message}`);
    }

    return { entries, diagnostics, missing: false };
}

function isFileNotFoundError(err: unknown): boolean {
    if (!err || typeof err !== "object") {
        return false;
    }
    // vscode.FileSystemError sets .code = 'FileNotFound'
    const e = err as { code?: string; name?: string };
    if (e.code === "FileNotFound" || e.code === "ENOENT") {
        return true;
    }
    if (e.name === "EntryNotFound (FileSystemError)") {
        return true;
    }
    return false;
}

/**
 * Validate entries before writing. Projects only approved fields.
 * Rejects entries missing a valid source (e.g. S3 entry without sourceUri).
 */
function validateForWrite(entries: ConfigTableEntry[]): { valid: ConfigTableEntry[]; errors: string[] } {
    const errors: string[] = [];
    const valid: ConfigTableEntry[] = [];
    const seenNames = new Set<string>();

    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        // Normalize BEFORE validation so whitespace cannot bypass safety checks
        const name = typeof e.name === "string" ? e.name.trim() : "";
        const source = typeof e.source === "string" ? e.source.trim() : "";

        // Validate required fields (against normalized values)
        if (!isNonEmptyString(name)) {
            errors.push(`Entry ${i}: missing or empty name`);
            continue;
        }
        if (!isValidSource(source)) {
            errors.push(`Entry ${i} ("${name}"): invalid source "${e.source}"`);
            continue;
        }
        if (!isValidFileType(e.fileType)) {
            errors.push(`Entry ${i} ("${name}"): invalid fileType "${e.fileType}"`);
            continue;
        }
        if (seenNames.has(name)) {
            errors.push(`Entry ${i}: duplicate name "${name}"`);
            continue;
        }
        seenNames.add(name);
        // Project only approved fields (already normalized)
        const projected: ConfigTableEntry = {
            name,
            source,
            fileType: e.fileType,
        };
        if (e.hivePartitioning === true) {
            projected.hivePartitioning = true;
        }
        valid.push(projected);
    }
    return { valid, errors };
}

/**
 * Write config to .filesql/config.json using safe same-directory temp+rename.
 * Does NOT silently fall back to non-atomic overwrite.
 * Directory creation errors propagate. Temp cleanup is best-effort.
 */
export async function writeConfig(
    workspaceRoot: vscode.Uri,
    entries: ConfigTableEntry[],
): Promise<void> {
    // Validate and project before write
    const { valid, errors } = validateForWrite(entries);
    if (errors.length > 0) {
        throw new Error(`Config write validation failed:\n${errors.join("\n")}`);
    }

    const dirUri = vscode.Uri.joinPath(workspaceRoot, CONFIG_DIR);
    const fileUri = configFileUri(workspaceRoot);

    // Ensure directory exists — let errors propagate
    await vscode.workspace.fs.createDirectory(dirUri);

    const content: ConfigFileContent = {
        version: CURRENT_VERSION,
        tables: valid,
    };

    const json = JSON.stringify(content, null, 2) + "\n";
    const bytes = Buffer.from(json, "utf-8");

    // Safe same-directory temp+rename for atomicity.
    const randomSuffix = crypto.randomBytes(8).toString("hex");
    const tmpUri = vscode.Uri.joinPath(dirUri, `config.tmp.${randomSuffix}.json`);
    let writeSucceeded = false;
    try {
        await vscode.workspace.fs.writeFile(tmpUri, bytes);
        writeSucceeded = true;
        await vscode.workspace.fs.rename(tmpUri, fileUri, { overwrite: true });
    } catch (err) {
        // Best-effort cleanup of temp file
        try {
            await vscode.workspace.fs.delete(tmpUri);
        } catch {
            // ignore cleanup failure
        }
        if (!writeSucceeded) {
            const e = new Error(`Failed to write temp config file: ${err instanceof Error ? err.message : String(err)}`);
            (e as unknown as Record<string, unknown>).cause = err;
            throw e;
        }
        const e = new Error(`Failed to rename temp config to final: ${err instanceof Error ? err.message : String(err)}`);
        (e as unknown as Record<string, unknown>).cause = err;
        throw e;
    }
}

/**
 * Convert a runtime TableEntry to the persisted ConfigTableEntry form.
 * Uses the preserved declarative `source` field when available.
 * For S3 entries: requires `source` or `sourceUri` — rejects temp paths.
 * For local entries: uses `source` if available, else derives workspace-relative path.
 * Returns null for entries that cannot produce a valid portable source:
 *  - S3 entries with no valid s3:// source
 *  - Local entries whose filePath is outside the workspace root
 * Normalizes backslashes to forward slashes on write.
 */
export function toConfigEntry(entry: TableEntry, workspaceRoot: string): ConfigTableEntry | null {
    let source: string;

    if (entry.isS3) {
        // Prefer preserved source, then sourceUri. Reject if neither has a valid S3 URI.
        if (entry.source && entry.source.startsWith("s3://") && parseS3Uri(entry.source)) {
            source = entry.source;
        } else if (entry.sourceUri && entry.sourceUri.startsWith("s3://") && parseS3Uri(entry.sourceUri)) {
            source = entry.sourceUri;
        } else {
            // Cannot derive a portable S3 source from a temp download path
            return null;
        }
    } else {
        // Prefer preserved source from config, else derive from filePath
        if (entry.source && !entry.source.startsWith("s3://")) {
            source = entry.source;
        } else {
            // Derive workspace-relative path — reject if outside workspace
            const posixRoot = workspaceRoot.replace(/\\/g, "/");
            const posixFile = entry.filePath.replace(/\\/g, "/");
            const prefix = posixRoot.endsWith("/") ? posixRoot : posixRoot + "/";
            if (posixFile.startsWith(prefix)) {
                source = "./" + posixFile.slice(prefix.length);
            } else {
                // File is outside workspace — cannot safely persist
                return null;
            }
        }
    }

    // Normalize: ensure forward slashes
    source = source.replace(/\\/g, "/");

    return {
        name: entry.name,
        source,
        fileType: entry.fileType,
        ...(entry.hivePartitioning === true ? { hivePartitioning: true } : {}),
    };
}
