/**
 * A small, safe spreadsheet formula engine for Friday sheets (no eval): numbers, text, A1 refs and
 * ranges, + - * / ^ &, comparisons, and SUM AVERAGE MIN MAX COUNT COUNTA ROUND ABS IF AND OR NOT
 * CONCAT LEN UPPER LOWER. Row 1 is the header row (the sheet's `columns`), data rows start at 2 —
 * the same addressing the xlsx export and Friday's update_page tool use, so a formula means the same
 * thing in the app, in Excel and to the model.
 */

export type Grid = { columns: string[]; rows: string[][] };
type Value = number | string | boolean;
export class FormulaError extends Error {}

export function colName(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Raw text of a cell by spreadsheet row (1 = header) and column index. */
function rawAt(grid: Grid, row: number, col: number): string {
  if (row === 1) return grid.columns[col] ?? "";
  return grid.rows[row - 2]?.[col] ?? "";
}

const NUMERIC = /^\s*[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?\s*%?\s*$/;

export function toNumber(v: Value): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const s = v.trim();
  if (!s) return 0;
  if (NUMERIC.test(s) && /\d/.test(s)) {
    const n = Number(s.replace(/,/g, "").replace("%", ""));
    return s.endsWith("%") ? n / 100 : n;
  }
  throw new FormulaError(`"${s.slice(0, 20)}" isn't a number`);
}

type Token = { t: "num" | "str" | "ref" | "range" | "fn" | "op" | "(" | ")" | ","; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '"') {
      const end = src.indexOf('"', i + 1);
      if (end === -1) throw new FormulaError("Unclosed quote");
      out.push({ t: "str", v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (num) { out.push({ t: "num", v: num[0] }); i += num[0].length; continue; }
    const range = /^\$?([A-Z]{1,3})\$?(\d{1,6}):\$?([A-Z]{1,3})\$?(\d{1,6})/i.exec(src.slice(i));
    if (range) { out.push({ t: "range", v: range[0].replace(/\$/g, "") }); i += range[0].length; continue; }
    const word = /^[A-Z_][A-Z0-9_.]*/i.exec(src.slice(i));
    if (word) {
      const w = word[0];
      if (src[i + w.length] === "(") out.push({ t: "fn", v: w.toUpperCase() });
      else if (/^\$?[A-Z]{1,3}\$?\d{1,6}$/i.test(w)) out.push({ t: "ref", v: w.replace(/\$/g, "") });
      else if (/^(TRUE|FALSE)$/i.test(w)) out.push({ t: "num", v: w.toUpperCase() === "TRUE" ? "1" : "0" });
      else throw new FormulaError(`Unknown name ${w}`);
      i += w.length;
      continue;
    }
    const op = /^(<=|>=|<>|[-+*/^&=<>])/.exec(src.slice(i));
    if (op) { out.push({ t: "op", v: op[0] }); i += op[0].length; continue; }
    if (ch === "(" || ch === ")" || ch === ",") { out.push({ t: ch, v: ch }); i++; continue; }
    if (ch === ";") { out.push({ t: ",", v: "," }); i++; continue; }
    throw new FormulaError(`Unexpected "${ch}"`);
  }
  return out;
}

/** Evaluates `=…` against the grid. `visiting` guards against circular references. */
export function evaluate(formula: string, grid: Grid, visiting: Set<string> = new Set()): Value {
  const tokens = tokenize(formula.replace(/^=/, ""));
  let p = 0;
  const peek = () => tokens[p];
  const take = () => tokens[p++];

  const cellValue = (ref: string): Value => {
    const m = /^([A-Z]{1,3})(\d+)$/i.exec(ref)!;
    const key = ref.toUpperCase();
    if (visiting.has(key)) throw new FormulaError("Circular reference");
    const raw = rawAt(grid, Number(m[2]), colIndex(m[1]!));
    if (raw.startsWith("=")) {
      visiting.add(key);
      try {
        return evaluate(raw, grid, visiting);
      } finally {
        visiting.delete(key);
      }
    }
    return raw;
  };

  const rangeValues = (range: string): Value[] => {
    const m = /^([A-Z]{1,3})(\d+):([A-Z]{1,3})(\d+)$/i.exec(range)!;
    const [c1, c2] = [colIndex(m[1]!), colIndex(m[3]!)].sort((a, b) => a - b) as [number, number];
    const [r1, r2] = [Number(m[2]), Number(m[4])].sort((a, b) => a - b) as [number, number];
    if ((r2 - r1 + 1) * (c2 - c1 + 1) > 100_000) throw new FormulaError("Range too large");
    const out: Value[] = [];
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) out.push(cellValue(`${colName(c)}${r}`));
    return out;
  };

  const numbersIn = (vals: Value[]) => vals.filter((v) => v !== "" && (typeof v !== "string" || (NUMERIC.test(v) && /\d/.test(v)))).map(toNumber);

  const callFn = (name: string, args: (Value | Value[])[]): Value => {
    const flat = args.flatMap((a) => (Array.isArray(a) ? a : [a]));
    const nums = () => numbersIn(flat);
    switch (name) {
      case "SUM": return nums().reduce((a, b) => a + b, 0);
      case "AVERAGE": case "AVG": { const n = nums(); if (!n.length) throw new FormulaError("AVERAGE of nothing"); return n.reduce((a, b) => a + b, 0) / n.length; }
      case "MIN": { const n = nums(); return n.length ? Math.min(...n) : 0; }
      case "MAX": { const n = nums(); return n.length ? Math.max(...n) : 0; }
      case "COUNT": return nums().length;
      case "COUNTA": return flat.filter((v) => v !== "").length;
      case "ROUND": { const d = args[1] !== undefined ? toNumber(args[1] as Value) : 0; const f = 10 ** d; return Math.round(toNumber(args[0] as Value) * f) / f; }
      case "ABS": return Math.abs(toNumber(args[0] as Value));
      case "IF": return truthy(args[0] as Value) ? (args[1] as Value ?? true) : (args[2] as Value ?? false);
      case "AND": return flat.every(truthy);
      case "OR": return flat.some(truthy);
      case "NOT": return !truthy(args[0] as Value);
      case "CONCAT": case "CONCATENATE": return flat.map(String).join("");
      case "LEN": return String(args[0] ?? "").length;
      case "UPPER": return String(args[0] ?? "").toUpperCase();
      case "LOWER": return String(args[0] ?? "").toLowerCase();
      default: throw new FormulaError(`Unknown function ${name}`);
    }
  };

  const truthy = (v: Value) => (typeof v === "boolean" ? v : typeof v === "number" ? v !== 0 : v !== "" && v.toUpperCase() !== "FALSE");

  // Precedence: comparison < & < +- < */ < ^ < unary
  function comparison(): Value {
    let left = concat();
    while (peek()?.t === "op" && ["=", "<>", "<", ">", "<=", ">="].includes(peek()!.v)) {
      const op = take()!.v;
      const right = concat();
      const [a, b] = typeof left === "string" || typeof right === "string" ? [String(left), String(right)] : [toNumber(left), toNumber(right)];
      left = op === "=" ? a === b : op === "<>" ? a !== b : op === "<" ? a < b : op === ">" ? a > b : op === "<=" ? a <= b : a >= b;
    }
    return left;
  }
  function concat(): Value {
    let left = additive();
    while (peek()?.t === "op" && peek()!.v === "&") { take(); left = String(left) + String(additive()); }
    return left;
  }
  function additive(): Value {
    let left = term();
    while (peek()?.t === "op" && (peek()!.v === "+" || peek()!.v === "-")) {
      const op = take()!.v;
      const right = term();
      left = op === "+" ? toNumber(left) + toNumber(right) : toNumber(left) - toNumber(right);
    }
    return left;
  }
  function term(): Value {
    let left = power();
    while (peek()?.t === "op" && (peek()!.v === "*" || peek()!.v === "/")) {
      const op = take()!.v;
      const right = toNumber(power());
      if (op === "/" && right === 0) throw new FormulaError("Division by zero");
      left = op === "*" ? toNumber(left) * right : toNumber(left) / right;
    }
    return left;
  }
  function power(): Value {
    const base = unary();
    if (peek()?.t === "op" && peek()!.v === "^") { take(); return toNumber(base) ** toNumber(power()); }
    return base;
  }
  function unary(): Value {
    if (peek()?.t === "op" && (peek()!.v === "-" || peek()!.v === "+")) {
      const op = take()!.v;
      const v = toNumber(unary());
      return op === "-" ? -v : v;
    }
    return primary();
  }
  function primary(): Value {
    const tok = take();
    if (!tok) throw new FormulaError("Formula ends too early");
    if (tok.t === "num") return Number(tok.v);
    if (tok.t === "str") return tok.v;
    if (tok.t === "ref") return cellValue(tok.v);
    if (tok.t === "range") throw new FormulaError("A range needs a function, e.g. SUM(A1:A5)");
    if (tok.t === "(") {
      const v = comparison();
      if (take()?.t !== ")") throw new FormulaError("Missing )");
      return v;
    }
    if (tok.t === "fn") {
      if (take()?.t !== "(") throw new FormulaError("Missing (");
      const args: (Value | Value[])[] = [];
      if (peek()?.t !== ")") {
        for (;;) {
          args.push(peek()?.t === "range" ? rangeValues(take()!.v) : comparison());
          if (peek()?.t === ",") { take(); continue; }
          break;
        }
      }
      if (take()?.t !== ")") throw new FormulaError("Missing )");
      return callFn(tok.v, args);
    }
    throw new FormulaError(`Unexpected ${tok.v}`);
  }

  const result = comparison();
  if (p < tokens.length) throw new FormulaError(`Unexpected ${tokens[p]!.v}`);
  return result;
}

/** What a cell shows: formulas evaluated (errors as #ERR), numbers formatted Indian-style. */
export function displayValue(raw: string, grid: Grid): { text: string; error?: string; numeric: boolean } {
  if (!raw.startsWith("=")) return { text: raw, numeric: NUMERIC.test(raw) && /\d/.test(raw) };
  try {
    const v = evaluate(raw, grid);
    if (typeof v === "number") return { text: Number.isFinite(v) ? v.toLocaleString("en-IN", { maximumFractionDigits: 6 }) : "#NUM!", numeric: true };
    if (typeof v === "boolean") return { text: v ? "TRUE" : "FALSE", numeric: false };
    return { text: v, numeric: false };
  } catch (err) {
    return { text: "#ERR", error: err instanceof Error ? err.message : "Error", numeric: false };
  }
}
