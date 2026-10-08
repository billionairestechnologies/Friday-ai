// Bundles the vendored Libraries.dev orbs + mascots (and the small React runtime they need) into media/fx.js.
import { build } from "esbuild";
await build({
  entryPoints: ["fx/entry.tsx"], outfile: "media/fx.js", bundle: true, minify: true, format: "iife",
  target: "es2020", jsx: "automatic", legalComments: "none", define: { "process.env.NODE_ENV": '"production"' },
});
console.log("media/fx.js built");
