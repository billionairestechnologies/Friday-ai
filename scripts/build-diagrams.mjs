#!/usr/bin/env node
/**
 * Rebuilds everything derived from the Mermaid sources in docs/diagrams:
 *   - <group>/<id>-<slug>.svg and .png (rendered with mermaid-cli)
 *   - docs/diagrams/README.md (the index)
 *   - docs/diagrams/BOSS_PACK.html (the one-file leadership pack, mermaid sources embedded)
 *   - docs/diagrams/friday-ai-diagrams.zip
 *
 * The single source of truth is docs/diagrams/diagrams.json + the .mmd files next to it. To add a diagram: write
 * <group>/<id>-<slug>.mmd, add it to diagrams.json, run `node scripts/build-diagrams.mjs`.
 *
 *   node scripts/build-diagrams.mjs            # render only what changed, rebuild index, pack and zip
 *   node scripts/build-diagrams.mjs --all      # re-render everything
 *   node scripts/build-diagrams.mjs --no-render   # index/pack/zip only (no browser needed)
 *
 * Rendering needs Chrome: set CHROME_PATH, or it tries the usual macOS/Linux locations.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "docs", "diagrams");
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "diagrams.json"), "utf8"));
const args = new Set(process.argv.slice(2));

const rel = (g, d, ext) => `${g.id}/${d.id}-${d.slug}.${ext}`;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function chromePath() {
  const candidates = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((c) => c && fs.existsSync(c));
}

function render() {
  const chrome = chromePath();
  if (!chrome) throw new Error("No Chrome found for rendering. Set CHROME_PATH or pass --no-render.");
  const cfg = path.join(os.tmpdir(), "friday-puppeteer.json");
  fs.writeFileSync(cfg, JSON.stringify({ executablePath: chrome, args: ["--no-sandbox"] }));
  let rendered = 0;
  for (const g of manifest.groups) {
    for (const d of g.diagrams) {
      const src = path.join(dir, rel(g, d, "mmd"));
      if (!fs.existsSync(src)) throw new Error(`Missing source ${rel(g, d, "mmd")}`);
      for (const ext of ["svg", "png"]) {
        const out = path.join(dir, rel(g, d, ext));
        const stale = args.has("--all") || !fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(src).mtimeMs;
        if (!stale) continue;
        const extra = ext === "png" ? ["-s", "2"] : [];
        execFileSync("npx", ["-y", "-p", "@mermaid-js/mermaid-cli@11", "mmdc", "-p", cfg, "-i", src, "-o", out, "-b", "white", ...extra], {
          stdio: ["ignore", "ignore", "inherit"],
          env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: "1" },
        });
        rendered++;
      }
    }
  }
  console.log(`rendered ${rendered} file(s)`);
}

function writeReadme() {
  const lines = [
    "# Friday diagrams",
    "",
    "Every architecture and product diagram, grouped by area. Each is a Mermaid source (`.mmd`) with generated `.svg` and `.png`.",
    "**Do not edit the generated files or this index by hand:** edit the `.mmd` (or `diagrams.json`) and run",
    "`node scripts/build-diagrams.mjs`.",
    "",
    "## For leadership (one file)",
    "",
    "Open **[BOSS_PACK.html](./BOSS_PACK.html)** in Chrome or Edge, then **Print / Save as PDF**, or download SVG/PNG under each",
    "diagram. Or take the zip: **[friday-ai-diagrams.zip](./friday-ai-diagrams.zip)**.",
    "",
  ];
  for (const g of manifest.groups) {
    lines.push(`## ${g.title}`, "", "| # | Diagram | PNG | SVG | Source |", "|---|---|---|---|---|");
    for (const d of g.diagrams) {
      lines.push(`| ${d.id} | ${d.title} | [png](./${rel(g, d, "png")}) | [svg](./${rel(g, d, "svg")}) | [mmd](./${rel(g, d, "mmd")}) |`);
    }
    lines.push("");
  }
  lines.push(
    "## Regenerating",
    "",
    "```bash",
    "node scripts/build-diagrams.mjs            # re-render changed diagrams, rebuild index, pack and zip",
    "node scripts/build-diagrams.mjs --all      # re-render everything",
    "node scripts/build-diagrams.mjs --no-render   # index, pack and zip only (no browser needed)",
    "```",
    "",
    "Written briefing: [`../architecture/PLATFORM_BRIEFING.md`](../architecture/PLATFORM_BRIEFING.md) · Friday X: [`../product/FRIDAY_X.md`](../product/FRIDAY_X.md) · Roadmap: [`../product/UPGRADE_ROADMAP.md`](../product/UPGRADE_ROADMAP.md)",
    "",
  );
  fs.writeFileSync(path.join(dir, "README.md"), lines.join("\n"));
}

function writePack() {
  const old = fs.readFileSync(path.join(dir, "BOSS_PACK.html"), "utf8");
  // Keep the page shell (script + styles) from the existing pack; regenerate header text and every section.
  const head = old.slice(0, old.indexOf("<body>"));
  const sections = [];
  let n = 0;
  for (const g of manifest.groups) {
    sections.push(`    <h2 class="group">${esc(g.title)}</h2>`);
    for (const d of g.diagrams) {
      n++;
      const mmd = fs.readFileSync(path.join(dir, rel(g, d, "mmd")), "utf8").trimEnd();
      const file = `${d.id}-${d.slug}`;
      sections.push(`    <section>
      <h2>${n}. ${esc(d.title)}</h2>
      <div class="actions">
        <button onclick="downloadSvg('${d.id}','${file}.svg')">Download SVG</button>
        <button class="secondary" onclick="downloadPng('${d.id}','${file}.png')">Download PNG</button>
      </div>
      <pre class="mermaid-src" data-id="${d.id}">
${esc(mmd)}
      </pre>
      <div class="diagram" id="render-${d.id}"></div>
    </section>
`);
    }
  }
  const body = `<body>
  <header>
    <h1>Friday — what we built</h1>
    <p class="meta">Leadership pack · generated from <code>docs/diagrams/</code> by <code>scripts/build-diagrams.mjs</code></p>
    <p>Open this file in a browser. Download SVG or PNG under each diagram, or use Print → Save as PDF for the whole pack.</p>
    <p><button class="print" onclick="window.print()">Print / Save as PDF</button></p>
  </header>
  <main>
    <section>
      <h2>In one page</h2>
      <ul class="share">
        <li><strong>Friday is an agent platform.</strong> Models use real tools (web, code, documents, the user's connected apps, MCP servers), remember users, run scheduled automations, and Build Mode is a coding agent that opens GitHub pull requests.</li>
        <li><strong>One account, every surface.</strong> Web, Android, iOS and now <strong>Friday X</strong>, a terminal and editor coding agent (VS Code, JetBrains, Zed). One plan, one model list, one usage meter.</li>
        <li><strong>The backend decides.</strong> Plans, entitlements, models and limits are edited in the Team Console and reach every client at once, with no app update.</li>
        <li><strong>Usage is metered in credits</strong> (what a call really costs us), enforced per round, and shown to users only as percent and reset time.</li>
        <li><strong>Company back office:</strong> support, CRM, plans and offers, finance and profit controls, mail hosting, status page with incidents and crash reports.</li>
      </ul>
    </section>

${sections.join("\n")}  </main>
</body>
</html>
`;
  fs.writeFileSync(path.join(dir, "BOSS_PACK.html"), head + body);
}

function writeZip() {
  const out = path.join(dir, "friday-ai-diagrams.zip");
  fs.rmSync(out, { force: true });
  const files = ["README.md", "BOSS_PACK.html"];
  for (const g of manifest.groups) for (const d of g.diagrams) for (const ext of ["mmd", "svg", "png"]) {
    if (fs.existsSync(path.join(dir, rel(g, d, ext)))) files.push(rel(g, d, ext));
  }
  execFileSync("zip", ["-q", out, ...files], { cwd: dir });
}

if (!args.has("--no-render")) render();
writeReadme();
writePack();
writeZip();
console.log("diagrams: index, pack and zip rebuilt");
