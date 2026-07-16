import React, { useCallback, useEffect, useRef, useState } from "react";
import "./styles.css";
import { QueryEditor } from "./components/QueryEditor";
import { ResultsTable } from "./components/ResultsTable";
import { Toolbar } from "./components/Toolbar";
import { ExportFormat, QueryResult, SavedQuery, TableEntry } from "../types";
import { isSuccessStatus, formatExportStatus } from "./exportHelpers";

declare const acquireVsCodeApi: () => {
  postMessage: (msg: unknown) => void;
};

const vscode = acquireVsCodeApi();

interface TabState {
  id: string;
  label: string;
  sql: string;
  result: QueryResult | null;
  error: string | null;
  running: boolean;
  exporting: boolean;
  exportStatus: string | null;
  exportError: string | null;
}

let _tabSeq = 1;
function createTab(): TabState {
  const n = _tabSeq++;
  return {
    id: `tab-${n}`,
    label: `untitled-${n}`,
    sql: "SELECT *\nFROM ",
    result: null,
    error: null,
    running: false,
    exporting: false,
    exportStatus: null,
    exportError: null,
  };
}

function createSavedTab(query: SavedQuery): TabState {
  const tab = createTab();
  return { ...tab, label: query.name, sql: query.sql };
}

/**
 * Returns true if the tab set is still the untouched initial default
 * (one tab matching the initial tab with no edits).
 */
export function isUntouchedInitialTabs(
  tabs: TabState[],
  initial: TabState,
): boolean {
  return (
    tabs.length === 1 &&
    tabs[0].id === initial.id &&
    tabs[0].sql === initial.sql &&
    tabs[0].label === initial.label
  );
}

export function App(): JSX.Element {
  const [tables, setTables] = useState<TableEntry[]>([]);
  const initialTab = useRef(createTab());
  const [tabs, setTabs] = useState<TabState[]>([initialTab.current]);
  const [activeTabId, setActiveTabId] = useState<string>(initialTab.current.id);
  const tabsRef = useRef<TabState[]>(tabs);
  // Keep tabsRef in sync with latest tabs state for immediate snapshot reads
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  const [editorHeight, setEditorHeight] = useState(220);
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [queriesHydrated, setQueriesHydrated] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const pendingFocusTabRef = useRef<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Each mounted QueryEditor registers its run function here keyed by tab id
  const runRefs = useRef<Map<string, React.MutableRefObject<() => void>>>(
    new Map(),
  );

  const dragging = useRef(false);
  const startY = useRef(0);
  const startHeight = useRef(0);

  // After a keyboard-driven close, move focus to the newly active tab
  useEffect(() => {
    if (pendingFocusTabRef.current) {
      const id = pendingFocusTabRef.current;
      pendingFocusTabRef.current = null;
      requestAnimationFrame(() => {
        document.getElementById(`tab-${id}`)?.focus();
      });
    }
  }, [tabs]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const msg = event.data as {
        type: string;
        payload: unknown;
        tabId?: string;
      };
      switch (msg.type) {
        case "tablesChanged":
          setTables((msg.payload as { tables: TableEntry[] }).tables);
          break;
        case "savedQueries": {
          const queries = (msg.payload as { queries: SavedQuery[] }).queries;
          if (queries.length > 0) {
            // Item 3: If user edited initial tab, preserve edit and append restored tabs
            const restoredTabs = queries.map(createSavedTab);
            setTabs((prev) => {
              if (isUntouchedInitialTabs(prev, initialTab.current)) {
                // Replace untouched default with restored tabs
                setActiveTabId(restoredTabs[0].id);
                return restoredTabs;
              }
              // Idempotent: skip queries already open (same name+sql)
              const existingSet = new Set(
                prev.map((t) => `${t.label}\0${t.sql}`),
              );
              const novel = restoredTabs.filter(
                (t) => !existingSet.has(`${t.label}\0${t.sql}`),
              );
              if (novel.length === 0) return prev;
              setActiveTabId(prev[0].id);
              return [...prev, ...novel];
            });
          }
          setQueriesHydrated(true);
          break;
        }
        case "queryResult":
          setTabs((prev) =>
            prev.map((t) =>
              t.id === msg.tabId
                ? {
                    ...t,
                    result: msg.payload as QueryResult,
                    error: null,
                    running: false,
                  }
                : t,
            ),
          );
          break;
        case "queryError":
          setTabs((prev) =>
            prev.map((t) =>
              t.id === msg.tabId
                ? {
                    ...t,
                    error: (msg.payload as { message: string }).message,
                    result: null,
                    running: false,
                  }
                : t,
            ),
          );
          break;
        case "exportResult":
          setTabs((prev) =>
            prev.map((t) =>
              t.id === msg.tabId
                ? {
                    ...t,
                    exporting: false,
                    exportStatus: formatExportStatus(
                      (msg.payload as { format: ExportFormat }).format,
                      (msg.payload as { path: string }).path,
                    ),
                    exportError: null,
                  }
                : t,
            ),
          );
          break;
        case "exportError":
          setTabs((prev) =>
            prev.map((t) =>
              t.id === msg.tabId
                ? {
                    ...t,
                    exporting: false,
                    exportStatus: null,
                    exportError: (msg.payload as { message: string }).message,
                  }
                : t,
            ),
          );
          break;
        case "requestQueryTabs": {
          // Respond immediately with current React state (not debounced)
          const reqPayload = msg.payload as { requestId?: string } | undefined;
          const requestId = reqPayload?.requestId;
          if (typeof requestId === "string") {
            // Read current state via ref for immediate snapshot
            vscode.postMessage({
              type: "queryTabsSnapshot",
              payload: {
                requestId,
                queries: tabsRef.current.map(({ label, sql }) => ({
                  name: label,
                  sql,
                })),
              },
            });
          }
          break;
        }
      }
    }
    window.addEventListener("message", onMessage);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (!queriesHydrated) return;
    // Item 2: Do not persist the untouched initial default tab
    if (isUntouchedInitialTabs(tabs, initialTab.current)) return;

    const timer = setTimeout(() => {
      vscode.postMessage({
        type: "queryTabsChanged",
        payload: {
          queries: tabs.map(({ label, sql }) => ({ name: label, sql })),
        },
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [queriesHydrated, tabs]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      dragging.current = true;
      startY.current = e.clientY;
      startHeight.current = editorHeight;
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";

      function onMouseMove(ev: MouseEvent) {
        if (!dragging.current) return;
        const delta = ev.clientY - startY.current;
        const newHeight = Math.max(
          80,
          Math.min(window.innerHeight - 120, startHeight.current + delta),
        );
        setEditorHeight(newHeight);
      }

      function onMouseUp() {
        dragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      }

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [editorHeight],
  );

  function handleRunSql(tabId: string, sql: string): void {
    if (!sql.trim()) return;
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId ? { ...t, running: true, error: null } : t,
      ),
    );
    vscode.postMessage({ type: "runQuery", payload: { sql, tabId } });
  }

  /** Called by the toolbar Run button — triggers the active editor's run fn */
  function handleRun(): void {
    const ref = runRefs.current.get(activeTabId);
    if (ref) {
      ref.current();
    }
  }

  function handleExport(format: ExportFormat): void {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === activeTabId
          ? { ...t, exporting: true, exportStatus: null, exportError: null }
          : t,
      ),
    );
    vscode.postMessage({
      type: "exportResults",
      payload: { tabId: activeTabId, format },
    });
  }

  function handleSqlChange(tabId: string, sql: string): void {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, sql } : t)));
  }

  function addTab(): void {
    const tab = createTab();
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }

  function startRename(tab: TabState, e: React.MouseEvent): void {
    e.stopPropagation();
    setRenamingTabId(tab.id);
    setRenameValue(tab.label);
    // Focus the input on next paint
    setTimeout(() => renameInputRef.current?.select(), 0);
  }

  function commitRename(): void {
    if (renamingTabId) {
      const trimmed = renameValue.trim();
      if (trimmed) {
        setTabs((prev) =>
          prev.map((t) =>
            t.id === renamingTabId ? { ...t, label: trimmed } : t,
          ),
        );
      }
    }
    setRenamingTabId(null);
  }

  function handleRenameKey(e: React.KeyboardEvent): void {
    if (e.key === "Enter") commitRename();
    if (e.key === "Escape") setRenamingTabId(null);
  }

  function closeTab(id: string, e: React.MouseEvent): void {
    e.stopPropagation();
    setTabs((prev) => {
      if (prev.length === 1) return prev;
      const next = prev.filter((t) => t.id !== id);
      if (activeTabId === id) {
        setActiveTabId(next[next.length - 1].id);
      }
      runRefs.current.delete(id);
      return next;
    });
  }

  function closeTabByKeyboard(id: string): void {
    setTabs((prev) => {
      if (prev.length === 1) return prev;
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      if (activeTabId === id) {
        // Prefer the tab to the right (same index), else last
        const newActive = next[Math.min(idx, next.length - 1)];
        setActiveTabId(newActive.id);
        pendingFocusTabRef.current = newActive.id;
      } else {
        // Focus stays on the currently active tab
        pendingFocusTabRef.current = activeTabId;
      }
      runRefs.current.delete(id);
      return next;
    });
  }

  /** Get or create a stable runRef for a given tab */
  function getRunRef(tabId: string): React.MutableRefObject<() => void> {
    if (!runRefs.current.has(tabId)) {
      runRefs.current.set(tabId, { current: () => {} });
    }
    return runRefs.current.get(tabId)!;
  }

  return (
    <div className="app-layout">
      {/* ── Tab bar ── */}
      <div className="tab-bar" role="tablist" aria-label="Query tabs">
        {tabs.map((tab, idx) => (
          <div
            key={tab.id}
            id={`tab-${tab.id}`}
            className={`tab${tab.id === activeTabId ? " tab--active" : ""}${tab.running ? " tab--running" : ""}`}
            role="tab"
            aria-selected={tab.id === activeTabId}
            aria-controls={`tabpanel-${tab.id}`}
            tabIndex={tab.id === activeTabId ? 0 : -1}
            onClick={() => setActiveTabId(tab.id)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") {
                e.preventDefault();
                const nextIdx = idx < tabs.length - 1 ? idx + 1 : 0;
                const next = tabs[nextIdx];
                setActiveTabId(next.id);
                const nextEl = document.getElementById(`tab-${next.id}`);
                nextEl?.focus();
              } else if (e.key === "ArrowLeft") {
                e.preventDefault();
                const prevIdx = idx > 0 ? idx - 1 : tabs.length - 1;
                const prev = tabs[prevIdx];
                setActiveTabId(prev.id);
                const prevEl = document.getElementById(`tab-${prev.id}`);
                prevEl?.focus();
              } else if (e.key === "Home") {
                e.preventDefault();
                const first = tabs[0];
                setActiveTabId(first.id);
                document.getElementById(`tab-${first.id}`)?.focus();
              } else if (e.key === "End") {
                e.preventDefault();
                const last = tabs[tabs.length - 1];
                setActiveTabId(last.id);
                document.getElementById(`tab-${last.id}`)?.focus();
              } else if (e.key === "Delete") {
                e.preventDefault();
                closeTabByKeyboard(tab.id);
              }
            }}
            title={tab.label}
          >
            {renamingTabId === tab.id ? (
              <input
                ref={renameInputRef}
                className="tab-rename-input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={handleRenameKey}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span
                className="tab-label"
                onDoubleClick={(e) => startRename(tab, e)}
                title="Double-click to rename"
              >
                {tab.label}
              </span>
            )}
            <button
              className="tab-close"
              tabIndex={-1}
              onClick={(e) => closeTab(tab.id, e)}
              aria-label={`Close ${tab.label}`}
              title="Close tab (Delete)"
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button
        className="tab-add"
        onClick={addTab}
        aria-label="New query tab"
        title="New query tab"
      >
        +
      </button>

      {/* ── Toolbar (run button + row count + export) ── */}
      <Toolbar
        onRun={handleRun}
        onExport={handleExport}
        running={activeTab.running}
        exporting={activeTab.exporting}
        result={activeTab.result}
        exportStatus={activeTab.exportStatus}
        exportError={activeTab.exportError}
      />

      {/* ── Editors (all mounted; non-active hidden) ── */}
      <div className="editor-wrapper" style={{ height: editorHeight }}>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            id={`tabpanel-${tab.id}`}
            role="tabpanel"
            aria-labelledby={`tab-${tab.id}`}
            style={{
              display: tab.id === activeTabId ? "block" : "none",
              height: "100%",
            }}
          >
            <QueryEditor
              tables={tables}
              onRun={(sql) => handleRunSql(tab.id, sql)}
              onChange={(sql) => handleSqlChange(tab.id, sql)}
              initialDoc={tab.sql}
              runRef={getRunRef(tab.id)}
            />
          </div>
        ))}
      </div>

      <div className="resize-handle" onMouseDown={handleMouseDown}>
        <div className="resize-handle-bar" />
      </div>

      <div className="results-panel">
        {tables.length === 0 ? (
          <div className="empty-table-hint">
            No tables loaded yet. Use the sidebar to <strong>Load</strong> a
            table, then run a query.
          </div>
        ) : activeTab.error ? (
          <div className="error-banner">{activeTab.error}</div>
        ) : isSuccessStatus(activeTab.result) ? (
          <div className="success-banner">Statement executed successfully.</div>
        ) : (
          <ResultsTable result={activeTab.result} />
        )}
      </div>
    </div>
  );
}
