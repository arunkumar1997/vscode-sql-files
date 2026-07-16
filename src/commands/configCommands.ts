import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import { DuckDBEngine } from "../duckdbEngine";
import { TableRegistry } from "../tableRegistry";
import { SavedQuery, TableEntry } from "../types";
import { readConfig, toConfigEntry, writeConfig, writeSavedQueries } from "../configManager";
import {
    cleanupPerLoadTempDir,
    createPerLoadTempDir,
    detectBucketRegion,
    downloadS3File,
    getConfig,
    groupS3KeysByFileType,
    listS3Keys,
    parseS3Uri,
    resolveAwsCredentials,
} from "../s3Handler";
import { detectFileType } from "../fileScanner";
import { log, logError } from "../logger";

// --- Promise-locked idempotent engine initialization ---

/**
 * Shared wrapper for engine.ensureInitialized() with user-facing error handling.
 * Returns true on success, false on failure.
 */
export async function ensureEngineInitialized(engine: DuckDBEngine): Promise<boolean> {
    try {
        await engine.ensureInitialized();
        return true;
    } catch (err: unknown) {
        logError("DuckDB failed to initialize", err);
        vscode.window.showErrorMessage(
            `File SQL: DuckDB failed to initialize — ${(err as Error).message}`,
        );
        return false;
    }
}

/** Exported for testing — no-op (init promise is now per-instance on DuckDBEngine). */
export function _resetEngineInitPromise(): void {
    // No-op: init state is now per-engine-instance, not module-level.
    // Tests should create fresh DuckDBEngine instances instead.
}

// --- Cancellation helper ---

class CancellationError extends Error {
    constructor() {
        super("Cancelled");
        this.name = "CancellationError";
    }
}

class StaleEntryError extends Error {
    constructor(tableName: string) {
        super(`Table "${tableName}" became stale during load`);
        this.name = "StaleEntryError";
    }
}

function checkCancellation(token?: vscode.CancellationToken): void {
    if (token?.isCancellationRequested) {
        throw new CancellationError();
    }
}

// --- Source resolution ---

function resolveLocalSource(source: string, workspaceRoot: string): string {
    return path.resolve(workspaceRoot, source);
}

// --- Stale-guard helper ---

function isEntryStale(
    tableName: string,
    runtimeId: string | undefined,
    registry: TableRegistry,
): boolean {
    const current = registry.get(tableName);
    if (!current) return true;
    return registry.getRuntimeId(tableName) !== runtimeId;
}

// --- Load Table ---

/**
 * Load a single configured table — transitions configured/error → loading → loaded|error.
 * Guards: blocks if already loading, requires configured or error state.
 * For local sources: resolves path and registers with failure-atomic introspection.
 * For S3 sources: downloads to per-load temp, then registers.
 * On cancellation: reverts to configured (not error).
 * On failure: cleans up temp, cleans up DuckDB view if partially registered.
 */
export async function loadTable(
    tableName: string,
    registry: TableRegistry,
    engine: DuckDBEngine,
    workspaceRoot: string,
    progress?: vscode.Progress<{ message?: string }>,
    token?: vscode.CancellationToken,
): Promise<boolean> {
    const entry = registry.get(tableName);
    if (!entry) {
        vscode.window.showErrorMessage(`File SQL: Table "${tableName}" not found.`);
        return false;
    }

    // Guard: only loadable states
    if (entry.loadState === "loading") {
        vscode.window.showWarningMessage(
            `File SQL: Table "${tableName}" is already loading.`,
        );
        return false;
    }
    if (entry.loadState === "loaded" || entry.loadState === undefined) {
        vscode.window.showWarningMessage(
            `File SQL: Table "${tableName}" is already loaded.`,
        );
        return false;
    }

    // Capture runtime ID for stale-guard
    const runtimeId = registry.getRuntimeId(tableName);

    // Transition to loading
    registry.setLoadState(tableName, "loading");

    // Check cancellation before async work
    if (token?.isCancellationRequested) {
        registry.setLoadState(tableName, "configured");
        return false;
    }

    // Lazy engine init (shared promise lock)
    if (!(await ensureEngineInitialized(engine))) {
        if (!isEntryStale(tableName, runtimeId, registry)) {
            registry.setLoadState(tableName, "error", "DuckDB failed to initialize");
        }
        return false;
    }

    // Stale guard after engine init
    if (isEntryStale(tableName, runtimeId, registry)) {
        return false;
    }

    try {
        if (entry.isS3) {
            await loadS3Table(entry, registry, engine, runtimeId, progress, token);
        } else {
            await loadLocalTable(entry, registry, engine, workspaceRoot, runtimeId, progress, token);
        }
        return true;
    } catch (err: unknown) {
        // Stale guard: check entry still exists
        if (!isEntryStale(tableName, runtimeId, registry)) {
            if (err instanceof CancellationError) {
                // Cancellation → back to configured, not error
                registry.setLoadState(tableName, "configured");
            } else {
                const msg = err instanceof Error ? err.message : String(err);
                registry.setLoadState(tableName, "error", msg);
                logError(`Failed to load table "${tableName}"`, err);
            }
        }
        return false;
    }
}

async function loadLocalTable(
    entry: TableEntry,
    registry: TableRegistry,
    engine: DuckDBEngine,
    workspaceRoot: string,
    runtimeId: string | undefined,
    progress?: vscode.Progress<{ message?: string }>,
    token?: vscode.CancellationToken,
): Promise<void> {
    const source = entry.source ?? entry.filePath;
    const resolvedPath = resolveLocalSource(source, workspaceRoot);

    progress?.report({ message: `Loading ${entry.name}…` });
    checkCancellation(token);

    // Update filePath to resolved absolute path for DuckDB
    entry.filePath = resolvedPath;

    // Failure-atomic: registerTable internally rolls back view on introspect failure.
    const cols = await engine.registerTable(entry);

    // Post-register: check cancellation and stale before committing loaded state.
    // Rollback the just-created view and return configured/false on cancel or stale.
    if (token?.isCancellationRequested) {
        try { await engine.dropTable(entry.name); } catch { /* best-effort */ }
        throw new CancellationError();
    }
    if (isEntryStale(entry.name, runtimeId, registry)) {
        try { await engine.dropTable(entry.name); } catch { /* best-effort */ }
        throw new StaleEntryError(entry.name);
    }

    entry.columns = cols;
    registry.setLoadState(entry.name, "loaded");
    log(`Table "${entry.name}" loaded from local source`);
}

async function loadS3Table(
    entry: TableEntry,
    registry: TableRegistry,
    engine: DuckDBEngine,
    runtimeId: string | undefined,
    progress?: vscode.Progress<{ message?: string }>,
    token?: vscode.CancellationToken,
): Promise<void> {
    const source = entry.source ?? entry.sourceUri;
    if (!source || !source.startsWith("s3://")) {
        throw new Error(`No valid S3 source for table "${entry.name}"`);
    }

    const parsed = parseS3Uri(source);
    if (!parsed) {
        throw new Error(`Invalid S3 URI for table "${entry.name}": ${source}`);
    }

    const { profile } = getConfig();

    progress?.report({ message: `Resolving credentials for ${entry.name}…` });
    checkCancellation(token);
    const creds = await resolveAwsCredentials(profile);

    checkCancellation(token);
    if (isEntryStale(entry.name, runtimeId, registry)) {
        throw new StaleEntryError(entry.name);
    }

    // Create AbortController BEFORE bucket-region lookup and propagate
    // AbortSignal through region/list/get/download/stream pipeline.
    const abortController = new AbortController();
    const cancelListener = token?.onCancellationRequested(() => abortController.abort());

    let loadTempDir: string | undefined;
    try {
        progress?.report({ message: `Detecting region for ${entry.name}…` });
        const region = await detectBucketRegion(parsed.bucket, creds, abortController.signal);

        checkCancellation(token);
        if (isEntryStale(entry.name, runtimeId, registry)) {
            throw new StaleEntryError(entry.name);
        }

        // Create per-load temp dir (owned by this load — cleaned up on failure/cancel/unload)
        loadTempDir = createPerLoadTempDir();

        const isFolder = parsed.prefix === "" || parsed.prefix.endsWith("/");

        if (isFolder) {
            await loadS3Folder(entry, parsed, creds, region, loadTempDir, engine, registry, runtimeId, progress, token, abortController.signal);
        } else {
            await loadS3SingleFile(entry, parsed, creds, region, loadTempDir, engine, registry, runtimeId, progress, token, abortController.signal);
        }

        // Store the temp dir path on the entry for cleanup on unload — ONLY on success
        (entry as TableEntry & { _tempDir?: string })._tempDir = loadTempDir;
    } catch (err) {
        // Cleanup temp on failure/cancel/stale — only this table's temp, not others
        if (loadTempDir) {
            cleanupPerLoadTempDir(loadTempDir);
        }
        throw err;
    } finally {
        cancelListener?.dispose();
    }
}

async function loadS3Folder(
    entry: TableEntry,
    parsed: { bucket: string; prefix: string },
    creds: { keyId: string; secret: string; token?: string },
    region: string,
    loadTempDir: string,
    engine: DuckDBEngine,
    registry: TableRegistry,
    runtimeId: string | undefined,
    progress?: vscode.Progress<{ message?: string }>,
    token?: vscode.CancellationToken,
    abortSignal?: AbortSignal,
): Promise<void> {
    progress?.report({ message: `Listing S3 objects for ${entry.name}…` });
    const keys = await listS3Keys(parsed.bucket, parsed.prefix, region, creds, abortSignal);

    if (keys.length === 0) {
        throw new Error(`No objects found at s3://${parsed.bucket}/${parsed.prefix}`);
    }

    checkCancellation(token);
    if (isEntryStale(entry.name, runtimeId, registry)) {
        throw new StaleEntryError(entry.name);
    }

    // Honor configured fileType: filter keys to only those matching the entry's declared fileType
    const configuredType = entry.fileType;
    const matchingKeys = keys.filter((k) => detectFileType(k) === configuredType);

    if (matchingKeys.length === 0) {
        const actualTypes = groupS3KeysByFileType(keys).map((g) => g.fileType);
        throw new Error(
            `S3 folder contains no files matching configured fileType "${configuredType}". ` +
            `Found types: [${actualTypes.join(", ")}]. ` +
            `Update the config entry's fileType or source to match the actual data.`,
        );
    }

    // If hivePartitioning is configured, validate that directory structure is hive-style
    const useHive = entry.hivePartitioning ?? false;
    if (useHive) {
        const allHive = matchingKeys.every((key) => {
            const relative = key.slice(parsed.prefix.length);
            const parts = relative.split("/").slice(0, -1); // directory segments only
            return parts.length > 0 && parts.every((p) => /^[A-Za-z_][A-Za-z0-9_]*=.+$/.test(p));
        });
        if (!allHive) {
            throw new Error(
                `S3 folder "${parsed.prefix}" has hivePartitioning=true in config, ` +
                `but not all files are under key=value directories. ` +
                `Remove hivePartitioning or fix the S3 layout.`,
            );
        }
    }

    // Download matching files preserving directory structure for hive
    const ext = path.extname(matchingKeys[0]);
    for (const key of matchingKeys) {
        checkCancellation(token);
        const relativePath = key.slice(parsed.prefix.length);
        // Validate path containment
        const parts = relativePath.split("/");
        if (parts.some((p) => p === ".." || p === "")) {
            throw new Error(`S3 key "${key}" contains invalid path segments (traversal rejected)`);
        }
        const destPath = path.join(loadTempDir, relativePath);
        const resolvedDest = path.resolve(destPath);
        const resolvedBase = path.resolve(loadTempDir);
        if (!resolvedDest.startsWith(resolvedBase + path.sep)) {
            throw new Error(`S3 key "${key}" resolves outside temp directory (path traversal rejected)`);
        }
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        progress?.report({ message: `Downloading ${path.basename(key)}…` });
        await downloadS3File(parsed.bucket, key, destPath, creds, region, abortSignal);
    }

    checkCancellation(token);
    if (isEntryStale(entry.name, runtimeId, registry)) {
        throw new StaleEntryError(entry.name);
    }

    // Build glob path for DuckDB — always recursive to capture nested files
    const globPath = path.join(loadTempDir, "**", `*${ext}`);

    entry.filePath = globPath;
    if (useHive) {
        entry.hivePartitioning = true;
    }

    // registerTable is failure-atomic internally (rolls back view on introspect failure)
    const cols = await engine.registerTable(entry);

    // Post-register: check cancellation and stale before committing loaded state.
    // Rollback the just-created view on cancel or stale identity.
    if (token?.isCancellationRequested) {
        try { await engine.dropTable(entry.name); } catch { /* best-effort */ }
        throw new CancellationError();
    }
    if (isEntryStale(entry.name, runtimeId, registry)) {
        try { await engine.dropTable(entry.name); } catch { /* best-effort */ }
        throw new StaleEntryError(entry.name);
    }

    entry.columns = cols;
    registry.setLoadState(entry.name, "loaded");
    log(`Table "${entry.name}" loaded from S3 folder`);
}

async function loadS3SingleFile(
    entry: TableEntry,
    parsed: { bucket: string; prefix: string },
    creds: { keyId: string; secret: string; token?: string },
    region: string,
    loadTempDir: string,
    engine: DuckDBEngine,
    registry: TableRegistry,
    runtimeId: string | undefined,
    progress?: vscode.Progress<{ message?: string }>,
    token?: vscode.CancellationToken,
    abortSignal?: AbortSignal,
): Promise<void> {
    const filename = path.basename(parsed.prefix);
    const localPath = path.join(loadTempDir, filename);

    progress?.report({ message: `Downloading ${entry.name}…` });
    await downloadS3File(parsed.bucket, parsed.prefix, localPath, creds, region, abortSignal);

    checkCancellation(token);
    if (isEntryStale(entry.name, runtimeId, registry)) {
        throw new StaleEntryError(entry.name);
    }

    entry.filePath = localPath;

    // registerTable is failure-atomic internally
    const cols = await engine.registerTable(entry);

    // Post-register: check cancellation and stale before committing loaded state.
    // Rollback the just-created view, clean temp, and return false on cancel or stale.
    if (token?.isCancellationRequested) {
        try { await engine.dropTable(entry.name); } catch { /* best-effort */ }
        throw new CancellationError();
    }
    if (isEntryStale(entry.name, runtimeId, registry)) {
        try { await engine.dropTable(entry.name); } catch { /* best-effort */ }
        throw new StaleEntryError(entry.name);
    }

    entry.columns = cols;
    registry.setLoadState(entry.name, "loaded");
    log(`Table "${entry.name}" loaded from S3 single file`);
}

// --- Import Workspace Configuration ---

export async function importWorkspaceConfig(
    registry: TableRegistry,
    workspaceRoot: vscode.Uri,
): Promise<boolean> {
    const { entries, diagnostics, missing } = await readConfig(workspaceRoot);
    if (diagnostics.length > 0) {
        vscode.window.showErrorMessage(
            `File SQL: Cannot import workspace configuration — ${diagnostics[0].message}`,
        );
        return false;
    }
    if (missing) {
        vscode.window.showInformationMessage(
            "File SQL: No .filesql/config.json workspace configuration found.",
        );
        return false;
    }

    // Item 4: Use reconcileConfig for proper add/update/remove semantics
    const report = registry.reconcileConfig(entries);
    const parts: string[] = [];
    if (report.added.length > 0) parts.push(`${report.added.length} added`);
    if (report.updated.length > 0) parts.push(`${report.updated.length} updated`);
    if (report.removed.length > 0) parts.push(`${report.removed.length} removed`);
    if (report.skipped.length > 0) parts.push(`${report.skipped.length} skipped (loaded/ad-hoc)`);
    const summary = parts.length > 0 ? parts.join(", ") : "no changes";
    vscode.window.showInformationMessage(
        `File SQL: Import complete — ${summary}.`,
    );
    return true;
}

// --- Unload Table ---

/**
 * Unload a loaded table — drops DuckDB view, clears columns, returns to configured.
 * Preserves loaded state on real drop failure (not just "view absent").
 * Cleans up per-load S3 temp directory without cross-table deletion.
 */
export async function unloadTable(
    tableName: string,
    registry: TableRegistry,
    engine: DuckDBEngine,
): Promise<boolean> {
    const entry = registry.get(tableName);
    if (!entry) {
        vscode.window.showErrorMessage(`File SQL: Table "${tableName}" not found.`);
        return false;
    }

    if (entry.loadState === "configured") {
        vscode.window.showWarningMessage(
            `File SQL: Table "${tableName}" is not loaded.`,
        );
        return false;
    }

    if (entry.loadState === "loading") {
        vscode.window.showWarningMessage(
            `File SQL: Cannot unload "${tableName}" while it is loading.`,
        );
        return false;
    }

    // Drop view — preserve loaded state on real failure
    if (engine.isReady() && (entry.loadState === "loaded" || entry.loadState === undefined)) {
        try {
            await engine.dropTable(tableName);
        } catch (err) {
            // Real drop failure — preserve loaded state so user can retry
            logError(`Failed to drop view for "${tableName}"`, err);
            vscode.window.showErrorMessage(
                `File SQL: Failed to unload "${tableName}" — ${(err as Error).message}`,
            );
            return false;
        }
    }

    // Clean up per-load S3 temp directory (if any) — only this table's temp
    const tempDir = (entry as TableEntry & { _tempDir?: string })._tempDir;
    if (tempDir) {
        cleanupPerLoadTempDir(tempDir);
        delete (entry as TableEntry & { _tempDir?: string })._tempDir;
    }

    // Clear runtime data
    entry.columns = undefined;
    // For S3 entries, filePath is a temp path — clear it back to source
    if (entry.isS3 && entry.source) {
        entry.filePath = entry.source;
    }

    registry.setLoadState(tableName, "configured");
    log(`Table "${tableName}" unloaded`);
    return true;
}

// --- Reload Table ---

/**
 * Reload a table — unload then load.
 * Safe for both config-origin and ad-hoc entries:
 * - Ad-hoc entries without source: re-register directly from filePath.
 * - Config entries or ad-hoc with source: unload + load cycle.
 */
export async function reloadTable(
    tableName: string,
    registry: TableRegistry,
    engine: DuckDBEngine,
    workspaceRoot: string,
): Promise<boolean> {
    const entry = registry.get(tableName);
    if (!entry) {
        vscode.window.showErrorMessage(`File SQL: Table "${tableName}" not found.`);
        return false;
    }

    if (entry.loadState === "loading") {
        vscode.window.showWarningMessage(
            `File SQL: Cannot reload "${tableName}" while it is loading.`,
        );
        return false;
    }

    // For ad-hoc entries without source — re-register directly from filePath
    // This is safe because filePath is absolute and already verified at add time
    if (entry.origin === "adhoc" && !entry.source) {
        if (!engine.isReady()) {
            vscode.window.showErrorMessage("File SQL: DuckDB engine not ready.");
            return false;
        }
        try {
            await engine.dropTable(tableName);
        } catch {
            // View may be absent
        }
        try {
            const cols = await engine.registerTable(entry);
            entry.columns = cols;
            // Keep loadState as undefined/loaded for adhoc (backward compat)
            if (entry.loadState === "error") {
                entry.loadState = undefined;
            }
            registry.updateColumns(tableName, cols);
            log(`Table "${tableName}" reloaded (ad-hoc)`);
            return true;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logError(`Failed to reload ad-hoc table "${tableName}"`, err);
            vscode.window.showErrorMessage(
                `File SQL: Failed to reload "${tableName}" — ${msg}`,
            );
            return false;
        }
    }

    // Config-origin or ad-hoc with source: unload then load
    if (entry.loadState === "loaded" || entry.loadState === undefined || entry.loadState === "error") {
        const unloaded = await unloadTable(tableName, registry, engine);
        if (!unloaded) {
            // unload failed (real drop failure) — don't proceed with load
            return false;
        }
    }

    // Load
    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `File SQL: Reloading ${tableName}…`,
            cancellable: true,
        },
        async (progress, token) => {
            return loadTable(tableName, registry, engine, workspaceRoot, progress, token);
        },
    );
}

// --- Save Workspace Configuration ---

/**
 * Save Workspace Configuration — writes all tables to .filesql/config.json.
 * ABORTS ENTIRELY if any entry cannot be represented, naming the problematic entries.
 * Explicit empty config save (no entries in registry) is valid and writes empty tables array.
 */
export async function saveWorkspaceConfig(
    registry: TableRegistry,
    workspaceRoot: vscode.Uri,
    queries?: SavedQuery[],
): Promise<boolean> {
    const allEntries = registry.getAll();
    const workspaceRootPath = workspaceRoot.fsPath;

    // If registry is empty, write empty config (valid explicit save)
    if (allEntries.length === 0) {
        try {
            // Write queries first so config.json is never ahead of query files
            if (queries) {
                await writeSavedQueries(workspaceRoot, queries);
            }
            await writeConfig(workspaceRoot, []);
            vscode.window.showInformationMessage(
                `File SQL: Workspace configuration saved to .filesql/config.json (0 tables, ${queries?.length ?? 0} queries).`,
            );
            log("Saved workspace config: 0 table(s)");
            return true;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            logError("Failed to save workspace config", err);
            vscode.window.showErrorMessage(
                `File SQL: Failed to save configuration — ${msg}`,
            );
            return false;
        }
    }

    // Convert all entries, track unrepresentable ones
    const configEntries: Array<NonNullable<ReturnType<typeof toConfigEntry>>> = [];
    const unrepresentable: string[] = [];

    for (const e of allEntries) {
        const converted = toConfigEntry(e, workspaceRootPath);
        if (converted) {
            configEntries.push(converted);
        } else {
            unrepresentable.push(e.name);
        }
    }

    // Abort entirely if any entries are unrepresentable
    if (unrepresentable.length > 0) {
        const names = unrepresentable.map((n) => `"${n}"`).join(", ");
        vscode.window.showErrorMessage(
            `File SQL: Cannot save — ${unrepresentable.length} table(s) cannot be represented in config: ${names}. ` +
            `(Files outside workspace or S3 entries missing source URIs.)`,
        );
        return false;
    }

    try {
        // Write queries BEFORE config.json — if queries fail, config is untouched
        if (queries) {
            await writeSavedQueries(workspaceRoot, queries);
        }
        await writeConfig(workspaceRoot, configEntries);
        vscode.window.showInformationMessage(
            `File SQL: Workspace configuration saved to .filesql/config.json (${configEntries.length} table(s), ${queries?.length ?? 0} queries).`,
        );
        log(`Saved workspace config: ${configEntries.length} table(s)`);
        return true;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logError("Failed to save workspace config", err);
        vscode.window.showErrorMessage(
            `File SQL: Failed to save configuration — ${msg}`,
        );
        return false;
    }
}
