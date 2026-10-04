// Search-engine surface for the SPA. The frontend is client-rendered, so without this every URL
// served the same bare index.html titled just "Friday": Google had nothing distinct to index per
// page (no sitelinks possible), /robots.txt and /sitemap.xml returned the app HTML, and unknown
// paths answered 200 (soft 404s). Here the server rewrites the <head> per route before sending it.

export const SITE_ORIGIN = (process.env.SITE_URL ?? "https://friday.billionairestechnologies.com").replace(/\/+$/, "");
const SITE_HOST = new URL(SITE_ORIGIN).host;

type PageMeta = { title: string; description: string };

/** Public, indexable pages. Keep in sync with frontend/src/lib/site/pages.ts and router.tsx. */
export const PUBLIC_PAGES: Record<string, PageMeta> = {
  "/": {
    title: "Friday — AI assistant for every top model",
    description:
      "Chat with GPT, Claude, Gemini and more in one place. Friday searches the web with sources, researches in depth, builds apps, works with your Gmail, Drive and GitHub, and runs tasks on a schedule.",
  },
  "/overview": {
    title: "Overview — Friday AI",
    description:
      "Friday is a multi-model AI assistant: chat, live web search, Deep Research, Build Mode, connectors, memory, automations and voice, in one app.",
  },
  "/plans": {
    title: "Plans & Pricing — Friday AI",
    description: "Start free. Upgrade to Pro or Premium for more usage and the most capable models, or get Friday for your team.",
  },
  "/build": {
    title: "Friday Build — describe an app, get a running app",
    description:
      "Build Mode writes, runs and fixes code in a secure cloud sandbox, shows a live preview, and can open a GitHub pull request for you.",
  },
  "/research": {
    title: "Deep Research — Friday AI",
    description: "Ask a hard question and Friday searches dozens of sources, reads them, and writes a cited report.",
  },
  "/connectors": {
    title: "Connectors — Friday AI",
    description:
      "Connect Gmail, Google Drive, Calendar, GitHub, Notion, Vercel, Railway, Supabase, Razorpay or any MCP server, and let Friday work with your real data.",
  },
  "/models": {
    title: "Models — GPT, Claude, Gemini and more in Friday",
    description:
      "One subscription, every top model. Pick a model yourself, let Auto choose the best one for each message, or use Team Up to have several models answer together.",
  },
  "/automations": {
    title: "Automations — Friday AI",
    description: "Schedule Friday to run tasks for you — a morning news brief, a weekly competitor scan, an inbox digest — and get notified when they're done.",
  },
  "/privacy": {
    title: "Privacy Policy — Friday AI",
    description: "What Friday collects, which AI providers and connectors see your data, and the controls you have — export, delete memory, disconnect accounts, delete your account.",
  },
  "/terms": {
    title: "Terms of Service — Friday AI",
    description: "The terms that apply to your use of Friday on web, Android and iOS.",
  },
  "/status": {
    title: "System Status — Friday AI",
    description: "Live status of Friday and every AI model it runs: uptime over 90 days, model success rates, current and past incidents. Report a problem to the team.",
  },
};

/** App pages that exist but are private or per-user — served, but kept out of search results. */
const PRIVATE_PREFIXES = ["/c/", "/build", "/pages", "/automations", "/admin", "/share/", "/mobile-auth-bridge", "/projects", "/team", "/library", "/upgrade", "/device"];

function isKnownAppPath(p: string) {
  return p in PUBLIC_PAGES || PRIVATE_PREFIXES.some((prefix) => p === prefix.replace(/\/$/, "") || p.startsWith(prefix));
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function normalizePath(p: string) {
  const trimmed = p.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

const STRUCTURED_DATA = JSON.stringify([
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Friday",
    alternateName: ["Friday AI", "Friday by Billionaires Technologies"],
    url: `${SITE_ORIGIN}/`,
  },
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Billionaires Technologies",
    url: `${SITE_ORIGIN}/`,
    logo: `${SITE_ORIGIN}/icon-512.png`,
  },
  {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Friday",
    applicationCategory: "ProductivityApplication",
    operatingSystem: "Web",
    url: `${SITE_ORIGIN}/`,
    description: PUBLIC_PAGES["/"].description,
    offers: { "@type": "Offer", price: "0", priceCurrency: "INR" },
    publisher: { "@type": "Organization", name: "Billionaires Technologies" },
  },
]).replace(/</g, "\\u003c");

export type RenderedPage = { status: number; html: string };

/** Rewrites the built index.html's <head> for one request path. */
export function renderIndexHtml(template: string, rawPath: string, host: string | undefined): RenderedPage {
  const p = normalizePath(rawPath);
  const meta = PUBLIC_PAGES[p];
  const known = isKnownAppPath(p);
  // The Railway subdomain serves the same app; only the custom domain should ever be indexed.
  const canonicalHost = !host || host === SITE_HOST;
  const indexable = Boolean(meta) && canonicalHost;

  const title = meta?.title ?? (known ? "Friday" : "Page not found — Friday");
  const description = meta?.description ?? PUBLIC_PAGES["/"].description;
  const url = `${SITE_ORIGIN}${p === "/" ? "/" : p}`;

  const tags = [
    `<meta name="description" content="${escapeHtml(description)}" />`,
    indexable ? `<link rel="canonical" href="${url}" />` : `<meta name="robots" content="noindex" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Friday" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:image" content="${SITE_ORIGIN}/icon-512.png" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(description)}" />`,
    p === "/" ? `<script type="application/ld+json">${STRUCTURED_DATA}</script>` : "",
  ]
    .filter(Boolean)
    .join("\n    ");

  const html = template
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(title)}</title>`)
    .replace(/\s*<meta name="description"[^>]*>/, "")
    .replace("</head>", `    ${tags}\n  </head>`);

  return { status: known ? 200 : 404, html };
}

export function robotsTxt(host: string | undefined) {
  if (host && host !== SITE_HOST) return "User-agent: *\nDisallow: /\n";
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "Disallow: /c/",
    "Disallow: /admin",
    "Disallow: /share/",
    "Disallow: /mobile-auth-bridge",
    "",
    `Sitemap: ${SITE_ORIGIN}/sitemap.xml`,
    "",
  ].join("\n");
}

export function sitemapXml(lastModified: Date) {
  const lastmod = lastModified.toISOString().slice(0, 10);
  const urls = Object.keys(PUBLIC_PAGES)
    .map(
      (p) =>
        `  <url><loc>${SITE_ORIGIN}${p}</loc><lastmod>${lastmod}</lastmod><priority>${p === "/" ? "1.0" : "0.8"}</priority></url>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
