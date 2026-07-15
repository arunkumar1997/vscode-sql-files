import React, { useEffect, useRef } from "react";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { sql, PostgreSQL } from "@codemirror/lang-sql";
import { oneDark } from "@codemirror/theme-one-dark";
import { defaultKeymap, historyKeymap, history } from "@codemirror/commands";
import {
  autocompletion,
  CompletionContext,
  CompletionResult,
  Completion,
} from "@codemirror/autocomplete";
import { TableEntry } from "../../types";

// SQL keywords shown with distinct "keyword" type in the autocomplete dropdown
const SQL_KEYWORDS: Completion[] = [
  "SELECT",
  "FROM",
  "WHERE",
  "GROUP BY",
  "ORDER BY",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "DISTINCT",
  "AS",
  "ON",
  "AND",
  "OR",
  "NOT",
  "IN",
  "LIKE",
  "BETWEEN",
  "IS NULL",
  "IS NOT NULL",
  "UNION",
  "UNION ALL",
  "INTERSECT",
  "EXCEPT",
  "WITH",
  "JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "INNER JOIN",
  "FULL OUTER JOIN",
  "CROSS JOIN",
  "INSERT INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE",
  "CREATE TABLE",
  "DROP TABLE",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "COALESCE",
  "NULLIF",
  "CAST",
  "OVER",
  "PARTITION BY",
  "ROW_NUMBER",
  "RANK",
  "DENSE_RANK",
  "LAG",
  "LEAD",
  "FIRST_VALUE",
  "LAST_VALUE",
  "CURRENT_DATE",
  "CURRENT_TIMESTAMP",
  "NOW",
  "DATE_TRUNC",
  "EXTRACT",
  "STRFTIME",
  "SUBSTRING",
  "TRIM",
  "UPPER",
  "LOWER",
  "LENGTH",
  "CONCAT",
  "ROUND",
  "FLOOR",
  "CEIL",
  "ABS",
].map((kw) => ({
  label: kw,
  type: "keyword",
  section: { name: "Keywords", rank: 2 },
}));

export interface Props {
  tables: TableEntry[];
  onRun: (sql: string) => void;
  onChange: (sql: string) => void;
  initialDoc?: string;
  /** Populated by the editor with a function that returns the selected text
   *  (or full doc if nothing is selected) and triggers onRun. */
  runRef?: React.MutableRefObject<() => void>;
}

export function QueryEditor({
  tables,
  onRun,
  onChange,
  initialDoc = "SELECT *\nFROM ",
  runRef,
}: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  const tablesRef = useRef(tables);
  tablesRef.current = tables;

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  // Always keep runRef pointing to the active view's run-selection function.
  // This runs after every render (no dep array) so switching tabs updates it.
  useEffect(() => {
    const view = viewRef.current;
    if (!runRef || !view) return;
    runRef.current = () => {
      const sel = view.state.selection.main;
      const text = sel.empty
        ? view.state.doc.toString()
        : view.state.sliceDoc(sel.from, sel.to).trim() ||
          view.state.doc.toString();
      onRunRef.current(text);
    };
  });

  useEffect(() => {
    if (!containerRef.current) return;

    function getRunSql(view: EditorView): string {
      const sel = view.state.selection.main;
      if (!sel.empty) {
        const selected = view.state.sliceDoc(sel.from, sel.to).trim();
        if (selected) return selected;
      }
      return view.state.doc.toString();
    }

    function sqlCompletion(
      context: CompletionContext,
    ): CompletionResult | null {
      const word = context.matchBefore(/\w*/);
      if (!word || (word.from === word.to && !context.explicit)) return null;

      const tableOptions: Completion[] = tablesRef.current.map((t) => ({
        label: t.name,
        type: "class",
        detail: t.fileType,
        section: { name: "Tables", rank: 0 },
        boost: 2,
      }));

      const columnOptions: Completion[] = tablesRef.current.flatMap((t) =>
        (t.columns ?? []).map((c) => ({
          label: c.name,
          type: "property",
          detail: `${t.name}.${c.type}`,
          section: { name: "Columns", rank: 1 },
        })),
      );

      return {
        from: word.from,
        options: [...tableOptions, ...columnOptions, ...SQL_KEYWORDS],
      };
    }

    const runCmd = keymap.of([
      {
        key: "Ctrl-Enter",
        run(view) {
          onRunRef.current(getRunSql(view));
          return true;
        },
      },
    ]);

    const state = EditorState.create({
      doc: initialDoc,
      extensions: [
        history(),
        sql({ dialect: PostgreSQL }),
        oneDark,
        keymap.of([...historyKeymap, ...defaultKeymap]),
        runCmd,
        autocompletion({ override: [sqlCompletion] }),
        EditorView.lineWrapping,
        EditorView.theme({
          "&": { height: "100%" },
          ".cm-scroller": { overflow: "auto" },
          ".cm-content": { paddingLeft: "12px", paddingRight: "12px" },
          ".cm-line": { paddingLeft: "0" },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    if (runRef) {
      runRef.current = () => onRunRef.current(getRunSql(view));
    }

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className="editor-container" />;
}
