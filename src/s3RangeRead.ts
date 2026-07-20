import * as vscode from "vscode";
import { DuckDBEngine } from "./duckdbEngine";
import { TableRegistry } from "./tableRegistry";
import { S3ReadMode, S3ReadModeSetting, TableEntry } from "./types";
import { buildS3Uris, getConfig, isRangeReadEligible, isSingleKeyRangeEligible } from "./s3Handler";
import { log, logError } from "./logger";

/**
 * Determine the effective read mode for an S3 Parquet import.
 * Returns "download" | "range" | undefined (cancelled).
 *
 * - If setting is "download" or "range", returns it directly (no prompt).
 * - If setting is "ask" and file(s) are eligible, prompts the user.
 * - If not eligible (non-parquet, mixed), always returns "download".
 */
export async function resolveS3ReadMode(
    keys: string[],
    settingOverride?: S3ReadModeSetting,
): Promise<S3ReadMode | undefined> {
    const setting = settingOverride ?? getConfig().s3ReadMode;

    // Check eligibility: all keys must be .parquet
    const eligible = keys.length > 0 && (keys.length === 1
        ? isSingleKeyRangeEligible(keys[0])
        : isRangeReadEligible(keys));

    if (!eligible) {
        return "download";
    }

    if (setting === "download") return "download";
    if (setting === "range") return "range";

    // setting === "ask" — prompt user
    const rangeItem: vscode.QuickPickItem = {
        label: "$(zap) Query with range reads",
        description: "Direct S3 access — no local copy, but requires network per query",
        detail: "DuckDB reads only needed byte ranges from S3. Generates multiple GET requests per query. Best for selective queries on large files.",
    };
    const downloadItem: vscode.QuickPickItem = {
        label: "$(cloud-download) Download first",
        description: "Download full file(s) to local temp, then query offline",
        detail: "Standard behavior — downloads the complete dataset before any query. Uses temp disk space.",
    };
    const cancelItem: vscode.QuickPickItem = {
        label: "$(close) Cancel",
        description: "Do not import this path",
    };

    const pick = await vscode.window.showQuickPick(
        [rangeItem, downloadItem, cancelItem],
        {
            placeHolder: "How should this S3 Parquet source be accessed?",
            ignoreFocusOut: true,
        },
    );

    if (!pick || pick === cancelItem) return undefined;
    if (pick === rangeItem) return "range";
    return "download";
}

/**
 * Execute the range-read registration workflow for a table.
 * Creates scoped S3 secret, registers view with S3 URIs, validates.
 * On validation failure: shows error, offers download fallback.
 * Returns true if registered successfully, false if user chose fallback or cancelled.
 */
export async function registerWithRangeRead(
    entry: TableEntry,
    bucket: string,
    prefix: string,
    keys: string[],
    credentials: { keyId: string; secret: string; token?: string },
    region: string,
    engine: DuckDBEngine,
    registry: TableRegistry,
    progress?: vscode.Progress<{ message?: string }>,
): Promise<"registered" | "fallback" | "cancelled"> {
    const s3Uris = buildS3Uris(bucket, keys);
    const hive = entry.hivePartitioning ?? false;

    progress?.report({ message: `Setting up range-read for ${entry.name}…` });

    try {
        // Create scoped secret
        await engine.createScopedS3Secret(
            entry.name,
            bucket,
            prefix,
            credentials,
            region,
        );

        // Register view pointing to S3 URIs
        const cols = await engine.registerRangeTable(entry, s3Uris, hive);

        // Validate with a lightweight query
        progress?.report({ message: `Validating range-read for ${entry.name}…` });
        await engine.validateRangeRead(entry.name);

        entry.columns = cols;
        entry.readMode = "range";
        log(`Table "${entry.name}" registered with range-read (${s3Uris.length} URI(s))`);
        return "registered";
    } catch (err: unknown) {
        // Cleanup secret and view on failure
        try { await engine.dropS3Secret(entry.name); } catch { /* best-effort */ }
        try { await engine.dropTable(entry.name); } catch { /* best-effort */ }

        const errMsg = err instanceof Error ? err.message : String(err);
        // Sanitize: remove anything that looks like credentials from error messages
        const sanitized = sanitizeErrorMessage(errMsg);
        logError(`Range-read validation failed for "${entry.name}"`, err);

        // Offer fallback
        const choice = await vscode.window.showErrorMessage(
            `Range-read failed for "${entry.name}": ${sanitized}`,
            { modal: false },
            "Download instead",
            "Cancel",
        );

        if (choice === "Download instead") {
            return "fallback";
        }
        return "cancelled";
    }
}

/**
 * Sanitize error messages to remove potential credential or token leakage.
 */
function sanitizeErrorMessage(msg: string): string {
    // Remove AWS-style keys (AKIA..., session tokens)
    let sanitized = msg.replace(/AKIA[A-Z0-9]{16}/g, "[REDACTED_KEY]");
    sanitized = sanitized.replace(/(?:session_?token|secret_?access_?key|access_?key_?id)\s*[:=]\s*\S+/gi, "[REDACTED]");
    // Remove anything that looks like a long base64 token
    sanitized = sanitized.replace(/[A-Za-z0-9+/=]{40,}/g, "[REDACTED_TOKEN]");
    return sanitized;
}
