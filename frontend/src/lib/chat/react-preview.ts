/**
 * Wraps a raw JSX/TSX snippet from a model reply into a standalone HTML document that can render
 * in Canvas's sandboxed iframe — React/ReactDOM/Babel load from a CDN inside that iframe (the
 * app's own bundle never touches this code), and Babel's in-browser transform handles the
 * JSX/TypeScript syntax since there's no build step for arbitrary model output.
 */

// Model output is written as a module (import/export), but there's no bundler in the iframe to
// resolve those against — only the two globals the CDN scripts define. Strip both so the snippet
// runs as a plain script, and remember the default-exported identifier (if any) as the component
// to mount.
function stripModuleSyntax(source: string): { code: string; exportedName: string | null } {
  let exportedName: string | null = null;

  let code = source.replace(/^\s*import\s+[^;]+;?\s*$/gm, "");

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
  code = code.replace(/^\s*export\s+(const|function|class)\s+/gm, "$1 ");

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
  "const { useState, useEffect, useRef, useMemo, useCallback, useContext, useReducer, useLayoutEffect, Fragment, StrictMode, createContext, memo, forwardRef } = React;";

// The two animation libraries model-generated "interactive demo" code (dice rolls, card flips,
// drag interactions...) reaches for by far the most often, after bare React. Their import lines
// get stripped like any other, so without loading the library and re-exposing its named exports
// here too, that code hits "gsap is not defined" / "motion is not defined" at render time —
// classified correctly as a react artifact now (see extractArtifact), but still failing to
// actually run. gsap's own UMD build already sets a bare `window.gsap` global, matching a plain
// `gsap.to(...)` call unmodified; framer-motion's does not (it's namespaced under `Motion`), so
// that one needs the same destructuring treatment as the React hooks above.
const MOTION_PRELUDE = "const { motion, AnimatePresence } = window.Motion ?? {};";

export function buildReactPreviewHtml(source: string): string {
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
<style>html,body{margin:0;min-height:100%;background:#fff}#root{min-height:100vh}</style>
</head>
<body>
<div id="root"></div>
<script id="user-code" type="text/babel" data-presets="react,typescript" data-type="module">
${REACT_HOOKS_PRELUDE}
${MOTION_PRELUDE}
${code}

try {
  const __root = ReactDOM.createRoot(document.getElementById("root"));
  __root.render(React.createElement(${mountName}));
} catch (err) {
  document.getElementById("root").innerHTML =
    '<pre style="padding:16px;color:#b91c1c;white-space:pre-wrap;font:12px/1.5 monospace">' +
    "Preview failed to render:\\n" + String(err && err.message ? err.message : err) +
    "</pre>";
}
<\/script>
</body>
</html>`;
}
