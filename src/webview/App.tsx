import React, { useCallback, useEffect, useRef, useState } from "react";
import "./styles.css";
import { QueryEditor } from "./components/QueryEditor";
import { ResultsTable } from "./components/ResultsTable";
import { Toolbar } from "./components/Toolbar";
import { QueryResult, TableEntry } from "../types";

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
}

let _tabSeq = 1;
function createTab(): TabState {
  const n = _tabSeq++;
  return {
    id: `tab-${n}`,
    label: `ARTS-untitled-${n}`,
    sql: "SELECT *\nFROM ",
    result: null,
    error: null,
    running: false,
  };
}

export function App(): JSX.Element {
  const [tables, setTables] = useState<TableEntry[]>([]);
  const initialTab = useRef(createTab());
  const [tabs, setTabs] = useState<TabState[]>([initialTab.current]);
  const [activeTabId, setActiveTabId] = useState<string>(initialTab.current.id);
  const [editorHeight, setEditorHeight] = useState(220);
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Each mounted QueryEditor registers its run function here keyed by tab id
  const runRefs = useRef<Map<string, React.MutableRefObject<() => void>>>(
    new Map(),
  );

  const dragging = useRef(false);
  const startY = useRef(0);
  const startHeight = useRef(0);

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
      }
    }
    window.addEventListener("message", onMessage);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

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
      <div className="tab-bar">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab${tab.id === activeTabId ? " tab--active" : ""}${tab.running ? " tab--running" : ""}`}
            onClick={() => setActiveTabId(tab.id)}
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
            <span
              className="tab-close"
              onClick={(e) => closeTab(tab.id, e)}
              title="Close tab"
            >
              ×
            </span>
          </div>
        ))}
        <button className="tab-add" onClick={addTab} title="New query tab">
          +
        </button>
      </div>

      {/* ── Toolbar (run button + row count) ── */}
      <Toolbar
        onRun={handleRun}
        running={activeTab.running}
        result={activeTab.result}
      />

      {/* ── Editors (all mounted; non-active hidden) ── */}
      <div className="editor-wrapper" style={{ height: editorHeight }}>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            style={{
              display: tab.id === activeTabId ? "block" : "none",
              height: "100%",
            }}
          >
            <QueryEditor
              tables={tables}
              onRun={(sql) => handleRunSql(tab.id, sql)}
              onChange={(sql) => handleSqlChange(tab.id, sql)}
              running={tab.running}
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
        {activeTab.error ? (
          <div className="error-banner">{activeTab.error}</div>
        ) : (
          <ResultsTable result={activeTab.result} />
        )}
      </div>
    </div>
  );
}
