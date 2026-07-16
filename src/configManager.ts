import * as vscode from "vscode";
import * as crypto from "crypto";
import { ConfigTableEntry, FileType, SavedQuery, TableEntry } from "./types";
import { logWarn, logError } from "./logger";
import { ensureUniqueQueryNames } from "./queryNames";

/** Directory and filename for workspace config. */
const CONFIG_DIR = ".filesql";
const CONFIG_FILE = "config.json";
const QUERIES_DIR = "queries";
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

export async function readSavedQueries(workspaceRoot: vscode.Uri): Promise<SavedQuery[]> {
    const queriesUri = vscode.Uri.joinPath(workspaceRoot, CONFIG_DIR, QUERIES_DIR);
    let entries: [string, vscode.FileType][];
    try {
        entries = await vscode.workspace.fs.readDirectory(queriesUri);
    } catch (err) {
        if (isFileNotFoundError(err)) {
            return [];
        }
        throw err;
    }

    const sqlFiles = new Map(
        entries
            .filter(([filename, fileType]) =>
                fileType === vscode.FileType.File &&
                filename.toLowerCase().endsWith(".sql") &&
                !filename.startsWith(".staging."),
            )
            .map(([filename]) => [filename.toLowerCase(), filename]),
    );
    const hasManifest = entries.some(([filename, fileType]) =>
        fileType === vscode.FileType.File && filename === MANAGED_MANIFEST,
    );
    const manifest = hasManifest
        ? await readManagedManifest(queriesUri)
        : { files: [], queries: [] };
    const orderedManaged = manifest.queries.length > 0
        ? manifest.queries
        : manifest.files.map((file) => ({ name: file.slice(0, -4), file }));
    const consumed = new Set<string>();
    const queries: SavedQuery[] = [];

    async function appendQuery(name: string, filename: string): Promise<void> {
        const actualFilename = sqlFiles.get(filename.toLowerCase());
        if (!actualFilename || consumed.has(actualFilename.toLowerCase())) {
            return;
        }
        consumed.add(actualFilename.toLowerCase());
        const uri = vscode.Uri.joinPath(queriesUri, actualFilename);
        const content = await vscode.workspace.fs.readFile(uri);
        queries.push({ name, sql: Buffer.from(content).toString("utf-8") });
    }

    for (const query of orderedManaged) {
        await appendQuery(query.name, query.file);
    }
    for (const filename of [...sqlFiles.values()].sort((a, b) => a.localeCompare(b))) {
        if (consumed.has(filename.toLowerCase())) {
            continue;
        }
        const uri = vscode.Uri.joinPath(queriesUri, filename);
        const content = await vscode.workspace.fs.readFile(uri);
        queries.push({
            name: filename.slice(0, -4),
            sql: Buffer.from(content).toString("utf-8"),
        });
    }
    return ensureUniqueQueryNames(queries);
}

/** Max base name length for query filenames (leaves room for `-N.sql` suffix). */
const MAX_QUERY_BASENAME = 100;

/** Manifest filename listing managed query files. */
const MANAGED_MANIFEST = ".filesql-managed.json";

/** Shape of the managed manifest on disk. */
interface ManagedManifest {
    /** Filenames (not full paths) of query SQL files managed by File SQL. */
    files: string[];
    /** Ordered query metadata preserving exact tab labels across save/import. */
    queries: Array<{ name: string; file: string }>;
}

/**
 * Sanitize a query name into a safe, deterministic filename base.
 * - Strips `.sql` suffix, trims whitespace
 * - Replaces runs of invalid filename characters with a single hyphen
 * - Collapses consecutive hyphens
 * - Strips leading/trailing hyphens
 * - Caps length to MAX_QUERY_BASENAME
 * - Falls back to `query-{index+1}` if empty
 */
export function sanitizeQueryBaseName(name: string, index: number): string {
    let base = name.trim();
    // Strip .sql suffix (case-insensitive)
    if (base.toLowerCase().endsWith(".sql")) {
        base = base.slice(0, -4);
    }
    // Replace invalid filename characters with hyphen using linear scan
    let result = "";
    let prevHyphen = false;
    for (let i = 0; i < base.length; i++) {
        const ch = base.charCodeAt(i);
        // Invalid: \/:*?"<>| and control chars (0x00-0x1f)
        const invalid = ch <= 0x1f || ch === 0x5c /* \ */ || ch === 0x2f /* / */
            || ch === 0x3a /* : */ || ch === 0x2a /* * */ || ch === 0x3f /* ? */
            || ch === 0x22 /* " */ || ch === 0x3c /* < */ || ch === 0x3e /* > */
            || ch === 0x7c /* | */;
        if (invalid) {
            if (!prevHyphen) {
                result += "-";
                prevHyphen = true;
            }
        } else {
            result += base[i];
            prevHyphen = false;
        }
    }
    // Strip leading/trailing hyphens
    let start = 0;
    let end = result.length;
    while (start < end && result[start] === "-") start++;
    while (end > start && result[end - 1] === "-") end--;
    result = result.slice(start, end);
    // Cap length
    if (result.length > MAX_QUERY_BASENAME) {
        result = result.slice(0, MAX_QUERY_BASENAME);
        // Trim trailing hyphens introduced by slice
        let trimEnd = result.length;
        while (trimEnd > 0 && result[trimEnd - 1] === "-") trimEnd--;
        result = result.slice(0, trimEnd);
    }
    if (!result) {
        return `query-${index + 1}`;
    }
    // Reject Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
    // These are reserved regardless of extension or casing.
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(result)) {
        result = `_${result}`;
    }
    return result;
}

/**
 * Read the managed manifest. Returns empty files list on missing/corrupt.
 */
async function readManagedManifest(queriesUri: vscode.Uri): Promise<ManagedManifest> {
    const manifestUri = vscode.Uri.joinPath(queriesUri, MANAGED_MANIFEST);
    try {
        const raw = await vscode.workspace.fs.readFile(manifestUri);
        const parsed = JSON.parse(Buffer.from(raw).toString("utf-8"));
        if (parsed && Array.isArray(parsed.files)) {
            const files = parsed.files.filter((file: unknown): file is string =>
                typeof file === "string",
            );
            const queries = Array.isArray(parsed.queries)
                ? parsed.queries.filter(
                    (query: unknown): query is { name: string; file: string } =>
                        typeof query === "object" && query !== null &&
                        typeof (query as { name?: unknown }).name === "string" &&
                        typeof (query as { file?: unknown }).file === "string",
                )
                : [];
            return { files, queries };
        }
    } catch {
        // Missing or corrupt — treat as empty (conservative)
    }
    return { files: [], queries: [] };
}

/**
 * Write managed manifest atomically (temp+rename).
 */
async function writeManagedManifest(queriesUri: vscode.Uri, manifest: ManagedManifest): Promise<void> {
    const manifestUri = vscode.Uri.joinPath(queriesUri, MANAGED_MANIFEST);
    const json = JSON.stringify(manifest, null, 2) + "\n";
    const bytes = Buffer.from(json, "utf-8");
    const tmpName = `.filesql-managed.tmp.${crypto.randomBytes(4).toString("hex")}.json`;
    const tmpUri = vscode.Uri.joinPath(queriesUri, tmpName);
    try {
        await vscode.workspace.fs.writeFile(tmpUri, bytes);
        await vscode.workspace.fs.rename(tmpUri, manifestUri, { overwrite: true });
    } catch (err) {
        try { await vscode.workspace.fs.delete(tmpUri); } catch { /* best-effort */ }
        throw err;
    }
}

/**
 * List existing .sql filenames (case-preserved) in the queries directory.
 */
async function listExistingSqlFiles(queriesUri: vscode.Uri): Promise<Set<string>> {
    const result = new Set<string>();
    try {
        const entries = await vscode.workspace.fs.readDirectory(queriesUri);
        for (const [name, type] of entries) {
            if (type === vscode.FileType.File && name.toLowerCase().endsWith(".sql")) {
                result.add(name);
            }
        }
    } catch {
        // Directory may not exist yet
    }
    return result;
}

export async function writeSavedQueries(
    workspaceRoot: vscode.Uri,
    queries: SavedQuery[],
): Promise<void> {
    const uniqueQueries = ensureUniqueQueryNames(queries);
    const queriesUri = vscode.Uri.joinPath(workspaceRoot, CONFIG_DIR, QUERIES_DIR);
    await vscode.workspace.fs.createDirectory(queriesUri);

    // 1. Read previous manifest (conservative on failure)
    const previousManifest = await readManagedManifest(queriesUri);
    const previousManagedSet = new Set(previousManifest.files.map(f => f.toLowerCase()));

    // 2. List existing files on disk to detect unmanaged files
    const existingFiles = await listExistingSqlFiles(queriesUri);

    // Build set of unmanaged filenames (case-insensitive)
    const unmanagedLower = new Set<string>();
    for (const f of existingFiles) {
        if (!previousManagedSet.has(f.toLowerCase())) {
            unmanagedLower.add(f.toLowerCase());
        }
    }

    // 3. Generate target filenames for current queries, avoiding unmanaged collisions
    const newManagedFiles: string[] = [];
    const generatedLower = new Set<string>();
    const writeOps: Array<{ filename: string; sql: string }> = [];

    for (let index = 0; index < uniqueQueries.length; index++) {
        const query = uniqueQueries[index];
        const baseName = sanitizeQueryBaseName(query.name, index);
        let filename = `${baseName}.sql`;
        let suffix = 2;
        // Avoid collisions with other generated names AND unmanaged files
        while (generatedLower.has(filename.toLowerCase()) || unmanagedLower.has(filename.toLowerCase())) {
            filename = `${baseName}-${suffix++}.sql`;
        }
        generatedLower.add(filename.toLowerCase());
        newManagedFiles.push(filename);
        writeOps.push({ filename, sql: query.sql });
    }

    // 4. STAGE: Write every query to a unique temp file WITHOUT touching finals.
    //    If any staging write fails, delete all temps and leave finals/manifest untouched.
    const stagedTemps: Array<{ tmpUri: vscode.Uri; finalUri: vscode.Uri; filename: string }> = [];
    try {
        for (const op of writeOps) {
            const finalUri = vscode.Uri.joinPath(queriesUri, op.filename);
            const tmpName = `.staging.${crypto.randomBytes(4).toString("hex")}.${op.filename}`;
            const tmpUri = vscode.Uri.joinPath(queriesUri, tmpName);
            await vscode.workspace.fs.writeFile(tmpUri, Buffer.from(op.sql, "utf-8"));
            stagedTemps.push({ tmpUri, finalUri, filename: op.filename });
        }
    } catch (err) {
        // Staging failed — delete all temps written so far, leave finals untouched
        for (const staged of stagedTemps) {
            try { await vscode.workspace.fs.delete(staged.tmpUri); } catch { /* best-effort */ }
        }
        const writeErr = new Error(`Failed to stage query files: ${err instanceof Error ? err.message : String(err)}`);
        (writeErr as unknown as { cause: unknown }).cause = err;
        throw writeErr;
    }

    // 5. PROMOTE: Rename temps to finals. Each rename is atomic.
    //    If a rename fails mid-promotion, we leave remaining temps (recoverable)
    //    but do NOT delete old managed files or update manifest.
    const promotedFiles: string[] = [];
    try {
        for (const staged of stagedTemps) {
            await vscode.workspace.fs.rename(staged.tmpUri, staged.finalUri, { overwrite: true });
            promotedFiles.push(staged.filename);
        }
    } catch (err) {
        // Promotion partially failed — clean up any remaining temps that weren't promoted
        for (const staged of stagedTemps) {
            if (!promotedFiles.includes(staged.filename)) {
                try { await vscode.workspace.fs.delete(staged.tmpUri); } catch { /* best-effort */ }
            }
        }
        const writeErr = new Error(`Failed to promote query files: ${err instanceof Error ? err.message : String(err)}`);
        (writeErr as unknown as { cause: unknown }).cause = err;
        throw writeErr;
    }

    // 6. Write manifest atomically (commits the batch).
    //    If manifest write fails, query files are newer but old manifest is intact
    //    so next run will reconcile safely (conservative: old manifest + new files on disk).
    await writeManagedManifest(queriesUri, {
        files: newManagedFiles,
        queries: writeOps.map((operation, index) => ({
            name: uniqueQueries[index].name,
            file: operation.filename,
        })),
    });

    // 7. Delete stale managed files ONLY AFTER manifest commit succeeds.
    const newManagedLower = new Set(newManagedFiles.map(f => f.toLowerCase()));
    for (const oldFile of previousManifest.files) {
        if (!newManagedLower.has(oldFile.toLowerCase())) {
            try {
                await vscode.workspace.fs.delete(vscode.Uri.joinPath(queriesUri, oldFile));
            } catch {
                // best-effort — file may already be gone
            }
        }
    }
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
