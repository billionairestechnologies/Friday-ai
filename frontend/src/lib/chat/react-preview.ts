/**
 * Wraps a raw JSX/TSX snippet from a model reply into a standalone HTML document that can render
 * in Canvas's sandboxed iframe — React/ReactDOM/Babel load from a CDN inside that iframe (the
 * app's own bundle never touches this code), and Babel's in-browser transform handles the
 * JSX/TypeScript syntax since there's no build step for arbitrary model output.
 */

// Which browser global each import source maps to inside the sandbox iframe (there's no bundler,
// only the CDN scripts below). Imports from anywhere else — "./App.css", local files — are dropped.
const MODULE_GLOBALS: Record<string, string> = {
  react: "React",
  "react-dom": "ReactDOM",
  "react-dom/client": "ReactDOM",
  "framer-motion": "(window.Motion || {})",
  "motion/react": "(window.Motion || {})",
  "lucide-react": "(window.LucideReact || {})",
  recharts: "(window.Recharts || {})",
  gsap: "({ gsap: window.gsap, default: window.gsap })",
};

// Turns `import X, { a, b as c } from "mod"` into `var X = ..., { a, b: c } = ...` against the
// matching global, so code written with normal imports runs unmodified. The old version stripped
// imports with `import\s+[^;]+;?` — for semicolon-less code (very common) that ate everything up
// to the next `;`, including the component itself → "App is not defined".
function convertImports(source: string): string {
  const fromRe = /^[ \t]*import\s+(type\s+)?([\w$*\s,{}]+?)\s+from\s+["']([^"']+)["']\s*;?[ \t]*$/gm;
  const sideEffectRe = /^[ \t]*import\s+["'][^"']+["']\s*;?[ \t]*$/gm;
  let out = source.replace(fromRe, (_m, typeOnly: string | undefined, clause: string, mod: string) => {
    const global = MODULE_GLOBALS[mod];
    if (typeOnly || !global) return "";
    const lines: string[] = [];
    const named = clause.match(/\{([\s\S]*)\}/)?.[1];
    const beforeBrace = clause.replace(/\{[\s\S]*\}/, "").replace(/,\s*$/, "").trim();
    const ns = beforeBrace.match(/^\*\s+as\s+([\w$]+)/)?.[1];
    if (ns) lines.push(`var ${ns} = ${global};`);
    // `import React from "react"` must not become `var React = ...` — that would hoist and shadow the global.
    else if (beforeBrace && beforeBrace !== global) lines.push(`var ${beforeBrace} = ${global}.default || ${global};`);
    if (named) {
      const specs = named
        .split(",")
        .map((x) => x.trim().replace(/^type\s+/, ""))
        .filter(Boolean)
        .map((x) => x.replace(/\s+as\s+/, ": "));
      if (specs.length) lines.push(`var { ${specs.join(", ")} } = ${global};`);
    }
    return lines.join(" ");
  });
  out = out.replace(sideEffectRe, "");
  return out;
}

// Module syntax has no bundler to resolve against, so imports become global lookups (above) and
// `export` is stripped; the default-exported identifier (if any) is remembered as the component to mount.
function stripModuleSyntax(source: string): { code: string; exportedName: string | null } {
  let exportedName: string | null = null;

  let code = convertImports(source);

  code = code.replace(/^\s*export\s+default\s+function\s+([A-Za-z_$][\w$]*)/m, (_m, name) => {
    exportedName = name;
    return `function ${name}`;
  });
  code = code.replace(/^\s*export\s+default\s+class\s+([A-Za-z_$][\w$]*)/m, (_m, name) => {
    exportedName = name;
    return `class ${name}`;
  });
  code = code.replace(/^\s*export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/m, (_m, name) => {
    exportedName = name;
    return "";
  });
  // Anonymous default export (`export default () => {...}` / `export default function () {...}`).
  code = code.replace(/^\s*export\s+default\s+/m, () => {
    exportedName = "__DefaultExport";
    return "const __DefaultExport = ";
  });
  code = code.replace(/^\s*export\s+(const|let|var|function|class|async function)\s+/gm, "$1 ");
  code = code.replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, "");

  return { code, exportedName };
}

function guessComponentName(code: string): string | null {
  const named = [...code.matchAll(/\bfunction\s+([A-Z][\w$]*)\s*\(/g), ...code.matchAll(/\bconst\s+([A-Z][\w$]*)\s*=/g)];
  if (named.length === 0) return null;
  const app = named.find((m) => m[1] === "App");
  return (app ?? named[named.length - 1])![1]!;
}

// Model output imports hooks by name (`import { useState } from "react"`), but the stripped
// script only has the single `React` UMD global to work with — re-expose the common named
// exports as locals so code written against normal React imports still runs unmodified.
const REACT_HOOKS_PRELUDE =
  "var { useState, useEffect, useRef, useMemo, useCallback, useContext, useReducer, useLayoutEffect, Fragment, StrictMode, createContext, memo, forwardRef } = React;";

// The two animation libraries model-generated "interactive demo" code (dice rolls, card flips,
// drag interactions...) reaches for by far the most often, after bare React. Their import lines
// get stripped like any other, so without loading the library and re-exposing its named exports
// here too, that code hits "gsap is not defined" / "motion is not defined" at render time —
// classified correctly as a react artifact now (see extractArtifact), but still failing to
// actually run. gsap's own UMD build already sets a bare `window.gsap` global, matching a plain
// `gsap.to(...)` call unmodified; framer-motion's does not (it's namespaced under `Motion`), so
// that one needs the same destructuring treatment as the React hooks above.
const MOTION_PRELUDE = "var { motion, AnimatePresence } = window.Motion ?? {};";

export function buildReactPreviewHtml(source: string, css = ""): string {
  const { code, exportedName } = stripModuleSyntax(source);
  const mountName = exportedName ?? guessComponentName(code) ?? "App";

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<script src="https://unpkg.com/react@18/umd/react.production.min.js"><\/script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"><\/script>
<script src="https://unpkg.com/@babel/standalone@7/babel.min.js"><\/script>
<script src="https://cdn.tailwindcss.com"><\/script>
<script src="https://unpkg.com/gsap@3/dist/gsap.min.js"><\/script>
<script src="https://unpkg.com/framer-motion@11/dist/framer-motion.js"><\/script>
<script src="https://unpkg.com/prop-types@15.8.1/prop-types.min.js"><\/script>
<script src="https://unpkg.com/react-is@18.3.1/umd/react-is.production.min.js"><\/script>
<script>window.react=window.React;<\/script>
<script src="https://unpkg.com/lucide-react@0.454.0/dist/umd/lucide-react.min.js"><\/script>
<script src="https://unpkg.com/recharts@2.12.7/umd/Recharts.js"><\/script>
<style>html,body{margin:0;min-height:100%;background:#fff}#root{min-height:100vh}</style>
${css ? `<style>${css.replace(/<\/style/gi, "<\\/style")}</style>` : ""}
</head>
<body>
<div id="root"></div>
<script>window.addEventListener("error", function (e) { var r = document.getElementById("root"); if (r && !r.hasChildNodes()) r.innerHTML = '<pre style="padding:16px;color:#b91c1c;white-space:pre-wrap;font:12px/1.5 monospace">Preview failed to render:\\n' + String(e.message).replace(/</g, "&lt;") + "</pre>"; });<\/script>
<script id="user-code" type="text/babel" data-presets="react,typescript" data-type="module">
${REACT_HOOKS_PRELUDE}
${MOTION_PRELUDE}
${code}

function __showError(msg) {
  document.getElementById("root").innerHTML =
    '<pre style="padding:16px;color:#b91c1c;white-space:pre-wrap;font:12px/1.5 monospace">' +
    "Preview failed to render:\\n" + String(msg).replace(/</g, "&lt;") + "</pre>";
}
try {
  const __Mount = typeof ${mountName} !== "undefined" ? ${mountName} : (typeof App !== "undefined" ? App : null);
  if (!__Mount) throw new Error("No component found — export a component (e.g. export default function App()).");
  class __Boundary extends React.Component {
    constructor(p) { super(p); this.state = { err: null }; }
    static getDerivedStateFromError(err) { return { err }; }
    render() {
      if (this.state.err) {
        return React.createElement("pre", { style: { padding: 16, color: "#b91c1c", whiteSpace: "pre-wrap", font: "12px/1.5 monospace" } },
          "Preview failed to render:\\n" + String(this.state.err && this.state.err.message ? this.state.err.message : this.state.err));
      }
      return this.props.children;
    }
  }
  ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(__Boundary, null, React.createElement(__Mount)));
} catch (err) {
  __showError(err && err.message ? err.message : err);
}
<\/script>
</body>
</html>`;
}
