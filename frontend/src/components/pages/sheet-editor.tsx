import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import type { SheetContent, SheetSpec } from "@/lib/pages/api";
import { colName, displayValue } from "@/lib/pages/formula";
import { cn } from "@/lib/utils";

/**
 * The spreadsheet editor: tabs of sheets, a header row (row 1, the sheet's `columns`) and data rows
 * from row 2 — the same A1 addressing Friday's update_page tool and the xlsx export use. Cells hold
 * text, numbers or `=formulas` (lib/pages/formula.ts). Click to select, type or double-click / Enter
 * to edit, arrows / Tab to move, Delete to clear, paste a block from Excel or Sheets.
 */

type Pos = { r: number; c: number }; // r = 0 is the header row
const MAX_RENDER_ROWS = 2000;

export function SheetEditor({ content, onChange, readOnly = false }: { content: SheetContent; onChange?: (c: SheetContent) => void; readOnly?: boolean }) {
  const [tab, setTab] = useState(0);
  const [sel, setSel] = useState<Pos>({ r: 1, c: 0 });
  const [editing, setEditing] = useState<{ pos: Pos; value: string; inBar?: boolean } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const sheets = content.sheets.length ? content.sheets : [{ name: "Sheet 1", columns: ["A"], rows: [[""]] }];
  const sheet = sheets[Math.min(tab, sheets.length - 1)]!;
  const width = Math.max(sheet.columns.length, ...sheet.rows.map((r) => r.length), 1);
  const height = sheet.rows.length + 1;

  useEffect(() => {
    if (tab >= sheets.length) setTab(sheets.length - 1);
  }, [sheets.length, tab]);

  const grid = useMemo(() => ({ columns: sheet.columns, rows: sheet.rows }), [sheet]);
  const raw = (p: Pos) => (p.r === 0 ? sheet.columns[p.c] : sheet.rows[p.r - 1]?.[p.c]) ?? "";

  function updateSheet(next: SheetSpec) {
    onChange?.({ sheets: sheets.map((s, i) => (i === tab ? next : s)) });
  }

  function setCells(cells: { pos: Pos; value: string }[]) {
    const columns = [...sheet.columns];
    const rows = sheet.rows.map((r) => [...r]);
    for (const { pos, value } of cells) {
      if (pos.r === 0) {
        while (columns.length <= pos.c) columns.push("");
        columns[pos.c] = value;
      } else {
        while (rows.length < pos.r) rows.push([]);
        const row = rows[pos.r - 1]!;
        while (row.length <= pos.c) row.push("");
        row[pos.c] = value;
      }
    }
    updateSheet({ ...sheet, columns, rows });
  }

  function commit(move?: Pos) {
    if (editing) {
      if (editing.value !== raw(editing.pos)) setCells([{ pos: editing.pos, value: editing.value }]);
      setEditing(null);
    }
    if (move) setSel(move);
    gridRef.current?.focus();
  }

  const clamp = (p: Pos): Pos => ({ r: Math.max(0, Math.min(height - 1, p.r)), c: Math.max(0, Math.min(width - 1, p.c)) });

  function onKey(e: React.KeyboardEvent) {
    if (readOnly || editing) return;
    const moves: Record<string, Pos> = { ArrowUp: { r: -1, c: 0 }, ArrowDown: { r: 1, c: 0 }, ArrowLeft: { r: 0, c: -1 }, ArrowRight: { r: 0, c: 1 } };
    if (moves[e.key]) {
      e.preventDefault();
      setSel(clamp({ r: sel.r + moves[e.key]!.r, c: sel.c + moves[e.key]!.c }));
    } else if (e.key === "Tab") {
      e.preventDefault();
      setSel(clamp({ r: sel.r, c: sel.c + (e.shiftKey ? -1 : 1) }));
    } else if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      setEditing({ pos: sel, value: raw(sel) });
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      setCells([{ pos: sel, value: "" }]);
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      setEditing({ pos: sel, value: e.key });
    }
  }

  function onPaste(e: React.ClipboardEvent) {
    if (readOnly || editing) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    const lines = text.replace(/\r/g, "").replace(/\n$/, "").split("\n").slice(0, 5000);
    const cells = lines.flatMap((line, i) => line.split("\t").slice(0, 100).map((value, j) => ({ pos: { r: sel.r + i, c: sel.c + j }, value })));
    setCells(cells);
  }

  function onCopy(e: React.ClipboardEvent) {
    if (editing) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", raw(sel));
  }

  const addRow = () => updateSheet({ ...sheet, rows: [...sheet.rows, Array(width).fill("")] });
  const addColumn = () => updateSheet({ ...sheet, columns: [...sheet.columns, colName(width)], rows: sheet.rows.map((r) => [...r, ...Array(Math.max(0, width - r.length)).fill(""), ""]) });
  const deleteRow = () => {
    if (sel.r === 0 || sheet.rows.length <= 1) return;
    updateSheet({ ...sheet, rows: sheet.rows.filter((_, i) => i !== sel.r - 1) });
    setSel(clamp({ r: sel.r - 1, c: sel.c }));
  };
  const deleteColumn = () => {
    if (width <= 1) return;
    updateSheet({ ...sheet, columns: sheet.columns.filter((_, i) => i !== sel.c), rows: sheet.rows.map((r) => r.filter((_, i) => i !== sel.c)) });
    setSel({ r: sel.r, c: Math.max(0, sel.c - 1) });
  };

  const selRaw = raw(sel);
  const selShown = selRaw.startsWith("=") ? displayValue(selRaw, grid) : null;
  const rows = sheet.rows.slice(0, MAX_RENDER_ROWS);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!readOnly && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-sm">
          <span className="w-14 shrink-0 rounded-md bg-chip px-2 py-1 text-center font-mono text-xs text-muted">
            {colName(sel.c)}
            {sel.r + 1}
          </span>
          <input
            aria-label="Cell contents"
            value={editing && editing.pos.r === sel.r && editing.pos.c === sel.c ? editing.value : selRaw}
            onChange={(e) => setEditing({ pos: sel, value: e.target.value, inBar: true })}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit(clamp({ r: sel.r + 1, c: sel.c }));
              if (e.key === "Escape") {
                setEditing(null);
                gridRef.current?.focus();
              }
            }}
            onBlur={() => commit()}
            placeholder="Value or =formula, e.g. =SUM(B2:B10)"
            className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-composer px-2.5 font-mono text-xs text-foreground outline-none focus:border-foreground/30"
          />
          {selShown?.error && <span className="shrink-0 text-xs text-danger">{selShown.error}</span>}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <ToolButton onClick={addRow}>
              <Plus className="size-3.5" /> Row
            </ToolButton>
            <ToolButton onClick={addColumn}>
              <Plus className="size-3.5" /> Column
            </ToolButton>
            <ToolButton onClick={deleteRow} disabled={sel.r === 0}>
              <Trash2 className="size-3.5" /> Row
            </ToolButton>
            <ToolButton onClick={deleteColumn}>
              <Trash2 className="size-3.5" /> Column
            </ToolButton>
          </div>
        </div>
      )}

      <div ref={gridRef} tabIndex={0} onKeyDown={onKey} onPaste={onPaste} onCopy={onCopy} className="min-h-0 flex-1 overflow-auto outline-none" data-testid="sheet-grid">
        <table className="border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th className="sticky top-0 left-0 z-30 h-7 w-12 min-w-12 border-r border-b border-border bg-chip" />
              {Array.from({ length: width }, (_, c) => (
                <th key={c} className={cn("sticky top-0 z-20 h-7 min-w-28 border-r border-b border-border bg-chip px-2 text-center text-xs font-medium text-muted", sel.c === c && "text-foreground")}>
                  {colName(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[sheet.columns, ...rows].map((row, ri) => (
              <tr key={ri}>
                <td className={cn("sticky left-0 z-10 h-8 border-r border-b border-border bg-chip px-2 text-center text-xs text-muted tabular-nums", sel.r === ri && "text-foreground")}>{ri + 1}</td>
                {Array.from({ length: width }, (_, c) => {
                  const value = row[c] ?? "";
                  const shown = displayValue(value, grid);
                  const isSel = sel.r === ri && sel.c === c;
                  const isEditing = editing && !editing.inBar && editing.pos.r === ri && editing.pos.c === c;
                  return (
                    <td
                      key={c}
                      onMouseDown={() => {
                        if (editing && !(editing.pos.r === ri && editing.pos.c === c)) commit();
                        setSel({ r: ri, c });
                      }}
                      onDoubleClick={() => !readOnly && setEditing({ pos: { r: ri, c }, value })}
                      title={shown.error}
                      className={cn(
                        "relative h-8 max-w-72 border-r border-b border-border px-2 whitespace-nowrap",
                        ri === 0 ? "bg-chip/50 font-semibold text-foreground" : "bg-background text-foreground",
                        shown.numeric && "text-right tabular-nums",
                        shown.error && "text-danger",
                        isSel && "outline-2 -outline-offset-2 outline-[#2563eb]",
                      )}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          aria-label={`Edit ${colName(c)}${ri + 1}`}
                          value={editing.value}
                          onChange={(e) => setEditing({ pos: editing.pos, value: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commit(clamp({ r: ri + 1, c }));
                            } else if (e.key === "Tab") {
                              e.preventDefault();
                              commit(clamp({ r: ri, c: c + (e.shiftKey ? -1 : 1) }));
                            } else if (e.key === "Escape") {
                              setEditing(null);
                              gridRef.current?.focus();
                            }
                          }}
                          onBlur={() => commit()}
                          className="absolute inset-0 z-10 w-full bg-background px-2 font-mono text-xs text-foreground outline-2 -outline-offset-2 outline-[#2563eb]"
                        />
                      ) : (
                        <span className="block overflow-hidden text-ellipsis">{shown.text}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {sheet.rows.length > MAX_RENDER_ROWS && <p className="p-3 text-xs text-muted">Showing the first {MAX_RENDER_ROWS} rows — export to Excel to see all {sheet.rows.length}.</p>}
      </div>

      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-border px-2 py-1">
        {sheets.map((s, i) => (
          <span key={i} className={cn("group flex h-8 items-center rounded-lg text-sm", i === tab ? "bg-chip-on text-foreground" : "text-muted hover:bg-chip")}>
            <button
              type="button"
              onClick={() => {
                commit();
                setTab(i);
                setSel({ r: 1, c: 0 });
              }}
              onDoubleClick={() => {
                if (readOnly) return;
                const name = window.prompt("Sheet name", s.name)?.trim();
                if (name) onChange?.({ sheets: sheets.map((x, j) => (j === i ? { ...x, name: name.slice(0, 31) } : x)) });
              }}
              className="h-full px-3"
            >
              {s.name}
            </button>
            {!readOnly && sheets.length > 1 && i === tab && (
              <button
                type="button"
                aria-label={`Delete ${s.name}`}
                onClick={() => {
                  if (!window.confirm(`Delete the sheet "${s.name}"?`)) return;
                  onChange?.({ sheets: sheets.filter((_, j) => j !== i) });
                  setTab(Math.max(0, i - 1));
                }}
                className="mr-1 flex size-5 items-center justify-center rounded text-muted hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            )}
          </span>
        ))}
        {!readOnly && (
          <button
            type="button"
            aria-label="Add sheet"
            onClick={() => {
              onChange?.({ sheets: [...sheets, { name: `Sheet ${sheets.length + 1}`, columns: ["A", "B", "C"], rows: [["", "", ""]] }] });
              setTab(sheets.length);
            }}
            className="flex size-8 items-center justify-center rounded-lg text-muted hover:bg-chip hover:text-foreground"
          >
            <Plus className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function ToolButton({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-muted transition-colors hover:bg-chip hover:text-foreground disabled:opacity-40">
      {children}
    </button>
  );
}
