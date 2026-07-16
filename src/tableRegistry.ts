import * as vscode from "vscode";
import * as crypto from "crypto";
import { ConfigTableEntry, TableEntry, TableLoadState } from "./types";

const STORAGE_KEY = "fileSql.registeredTables";

export class TableRegistry {
  private tables = new Map<string, TableEntry>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private memento: vscode.Memento | undefined;
  /** Hash of the last config load — used as mutation guard for reload detection. */
  private _lastConfigDigest: string | undefined;
  /** Runtime-only identifiers for entries (not persisted). */
  private runtimeIds = new Map<string, string>();

  /** Bind a workspace-state memento for persistence. */
  setStorage(memento: vscode.Memento): void {
    this.memento = memento;
  }

  add(entry: TableEntry): void {
    // Ad-hoc origin by default
    if (!entry.origin) {
      entry.origin = "adhoc";
    }
    // Reject replacing an entry that is currently loading
    const existing = this.tables.get(entry.name);
    if (existing?.loadState === "loading") {
      throw new Error(`Cannot replace table "${entry.name}" while it is loading`);
    }
    this.tables.set(entry.name, entry);
    this.runtimeIds.set(entry.name, crypto.randomUUID());
    this._onDidChange.fire();
    this.persist();
  }

  remove(name: string): boolean {
    const entry = this.tables.get(name);
    if (!entry) {
      return false;
    }
    // Block remove during loading
    if (entry.loadState === "loading") {
      throw new Error(`Cannot remove table "${name}" while it is loading`);
    }
    this.tables.delete(name);
    this.runtimeIds.delete(name);
    this._onDidChange.fire();
    this.persist();
    return true;
  }

  get(name: string): TableEntry | undefined {
    return this.tables.get(name);
  }

  getAll(): TableEntry[] {
    return Array.from(this.tables.values());
  }

  has(name: string): boolean {
    return this.tables.has(name);
  }

  clear(): void {
    // Block clear if any table is currently loading
    for (const entry of this.tables.values()) {
      if (entry.loadState === "loading") {
        throw new Error("Cannot clear tables while one or more tables are loading");
      }
    }
    this.tables.clear();
    this.runtimeIds.clear();
    this._onDidChange.fire();
    this.persist();
  }

  rename(oldName: string, newName: string): boolean {
    if (oldName === newName) {
      return this.tables.has(oldName);
    }
    const entry = this.tables.get(oldName);
    if (!entry) {
      return false;
    }
    // Block rename during loading
    if (entry.loadState === "loading") {
      throw new Error(`Cannot rename table "${oldName}" while it is loading`);
    }
    if (this.tables.has(newName)) {
      throw new Error(`Table "${newName}" already exists`);
    }
    this.tables.delete(oldName);
    entry.name = newName;
    this.tables.set(newName, entry);
    // Preserve runtime identity through rename
    const rid = this.runtimeIds.get(oldName);
    this.runtimeIds.delete(oldName);
    if (rid) {
      this.runtimeIds.set(newName, rid);
    }
    this._onDidChange.fire();
    this.persist();
    return true;
  }

  updateColumns(name: string, columns: TableEntry["columns"]): void {
    const entry = this.tables.get(name);
    if (entry) {
      entry.columns = columns;
      this._onDidChange.fire();
      this.persist();
    }
  }

  /** Get the stable runtime identity for an entry (not persisted to config). */
  getRuntimeId(name: string): string | undefined {
    return this.runtimeIds.get(name);
  }

  /** Load persisted entries into the in-memory map (does NOT register with engine). */
  loadFromStorage(): TableEntry[] {
    if (!this.memento) {
      return [];
    }
    const stored = this.memento.get<TableEntry[]>(STORAGE_KEY, []);
    // Filter out any entries that leaked with config origin or configured state
    const filtered = stored.filter(
      (entry) => entry.origin !== "config" && entry.loadState !== "configured",
    );
    for (const entry of filtered) {
      // Persisted entries are always adhoc origin (config entries are never persisted)
      entry.origin = "adhoc";
      // Clear any loadState that isn't appropriate for restored entries
      if (entry.loadState === "loading" || entry.loadState === "error") {
        entry.loadState = undefined;
      }
      this.tables.set(entry.name, entry);
      this.runtimeIds.set(entry.name, crypto.randomUUID());
    }
    if (filtered.length > 0) {
      this._onDidChange.fire();
    }
    return filtered;
  }

  /** Persist only adhoc-origin entries. Config-origin entries must never leak into workspaceState. */
  private persist(): void {
    if (!this.memento) {
      return;
    }
    const adhocEntries = Array.from(this.tables.values()).filter(
      (e) => e.origin === "adhoc" || e.origin === undefined,
    );
    this.memento.update(STORAGE_KEY, adhocEntries);
  }

  /**
   * Add entries from config as 'configured' (not yet loaded).
   * Skips entries whose name already exists in the registry (ad-hoc or memento wins).
   * Does NOT trigger DuckDB registration.
   * Does NOT persist to workspaceState.
   * Stores a digest of the config entries for mutation guard.
   * Source is set declaratively at creation and treated as immutable.
   */
  addConfigured(entries: ConfigTableEntry[]): void {
    // Compute and store config digest for mutation detection
    this._lastConfigDigest = this.computeConfigDigest(entries);

    let changed = false;
    for (const entry of entries) {
      // Normalize name and source before all checks (whitespace cannot bypass safety)
      const name = entry.name.trim();
      const source = entry.source.trim();
      if (this.tables.has(name)) {
        continue; // existing entry wins — backward compat
      }
      const tableEntry: TableEntry = {
        name,
        filePath: source, // runtime filePath initially mirrors source; resolved on load
        fileType: entry.fileType,
        isS3: source.startsWith("s3://"),
        sourceUri: source.startsWith("s3://") ? source : undefined,
        hivePartitioning: entry.hivePartitioning,
        loadState: "configured",
        origin: "config",
        source, // declarative and immutable
      };
      Object.defineProperty(tableEntry, "source", {
        value: source,
        writable: false,
        enumerable: true,
        configurable: true,
      });
      this.tables.set(name, tableEntry);
      this.runtimeIds.set(name, crypto.randomUUID());
      changed = true;
    }
    if (changed) {
      this._onDidChange.fire();
      // NOTE: no persist() call — config entries must not go to workspaceState
    }
  }

  /**
   * Transition a table's load state. Fires onDidChange.
   * No-op if the table doesn't exist.
   */
  setLoadState(name: string, state: TableLoadState, error?: string): void {
    const entry = this.tables.get(name);
    if (!entry) {
      return;
    }
    entry.loadState = state;
    entry.loadError = state === "error" ? error : undefined;
    this._onDidChange.fire();
    this.persist();
  }

  /** Returns only tables with loadState 'loaded' (or undefined for backward compat). */
  getLoaded(): TableEntry[] {
    return Array.from(this.tables.values()).filter(
      (e) => e.loadState === "loaded" || e.loadState === undefined,
    );
  }

  /** Get the last computed config digest (for external mutation detection). */
  get lastConfigDigest(): string | undefined {
    return this._lastConfigDigest;
  }

  /** Check if a set of config entries matches the last loaded config. */
  isConfigUnchanged(entries: ConfigTableEntry[]): boolean {
    return this.computeConfigDigest(entries) === this._lastConfigDigest;
  }

  private computeConfigDigest(entries: ConfigTableEntry[]): string {
    // Simple deterministic JSON serialization for comparison
    const normalized = entries
      .map((e) => `${e.name}|${e.source}|${e.fileType}|${e.hivePartitioning ?? ""}`)
      .sort()
      .join("\n");
    // Simple hash (djb2) — sufficient for change detection, not crypto
    let hash = 5381;
    for (let i = 0; i < normalized.length; i++) {
      hash = ((hash << 5) + hash + normalized.charCodeAt(i)) | 0;
    }
    return hash.toString(36);
  }

  dispose(): void {
    this._onDidChange.dispose();
  }

  /**
   * Reconcile registry state against a new set of config entries.
   * - Adds new entries not already present.
   * - Updates changed config-origin entries that are configured or error (not loading/loaded).
   * - Removes config-origin configured/error entries that are no longer in config.
   * - Preserves loaded tables, loading tables, and all ad-hoc entries.
   * Returns a report of actions taken.
   */
  reconcileConfig(entries: ConfigTableEntry[]): {
    added: string[];
    updated: string[];
    removed: string[];
    skipped: string[];
  } {
    const result = { added: [] as string[], updated: [] as string[], removed: [] as string[], skipped: [] as string[] };

    // Build lookup of incoming entries
    const incoming = new Map<string, ConfigTableEntry>();
    for (const e of entries) {
      incoming.set(e.name.trim(), e);
    }

    // Update config digest
    this._lastConfigDigest = this.computeConfigDigest(entries);

    // Pass 1: Remove config-origin entries no longer in incoming (only configured/error)
    for (const [name, existing] of Array.from(this.tables.entries())) {
      if (existing.origin !== "config") continue;
      if (!incoming.has(name)) {
        if (existing.loadState === "configured" || existing.loadState === "error") {
          this.tables.delete(name);
          this.runtimeIds.delete(name);
          result.removed.push(name);
        } else {
          // loading or loaded — preserve, report as skipped
          result.skipped.push(name);
        }
      }
    }

    // Pass 2: Add or update entries
    for (const entry of entries) {
      const name = entry.name.trim();
      const source = entry.source.trim();
      const existing = this.tables.get(name);

      if (!existing) {
        // New entry — check for ad-hoc collision
        const tableEntry: TableEntry = {
          name,
          filePath: source,
          fileType: entry.fileType,
          isS3: source.startsWith("s3://"),
          sourceUri: source.startsWith("s3://") ? source : undefined,
          hivePartitioning: entry.hivePartitioning,
          loadState: "configured",
          origin: "config",
          source,
        };
        Object.defineProperty(tableEntry, "source", {
          value: source,
          writable: false,
          enumerable: true,
          configurable: true,
        });
        this.tables.set(name, tableEntry);
        this.runtimeIds.set(name, crypto.randomUUID());
        result.added.push(name);
      } else if (existing.origin === "config") {
        // Config-origin entry exists — check if source changed
        const existingSource = (existing.source ?? existing.filePath ?? "").trim();
        const sourceChanged = existingSource !== source || existing.fileType !== entry.fileType || (existing.hivePartitioning ?? false) !== (entry.hivePartitioning ?? false);
        if (sourceChanged) {
          if (existing.loadState === "configured" || existing.loadState === "error") {
            // Safe to update
            existing.filePath = source;
            existing.fileType = entry.fileType;
            existing.isS3 = source.startsWith("s3://");
            existing.sourceUri = source.startsWith("s3://") ? source : undefined;
            existing.hivePartitioning = entry.hivePartitioning;
            existing.loadState = "configured";
            existing.loadError = undefined;
            Object.defineProperty(existing, "source", {
              value: source,
              writable: false,
              enumerable: true,
              configurable: true,
            });
            result.updated.push(name);
          } else {
            // loading or loaded — skip update
            result.skipped.push(name);
          }
        }
        // If source unchanged — no-op
      } else {
        // Ad-hoc entry with same name — skip (ad-hoc wins)
        result.skipped.push(name);
      }
    }

    const changed = result.added.length > 0 || result.updated.length > 0 || result.removed.length > 0;
    if (changed) {
      this._onDidChange.fire();
    }
    return result;
  }
}
