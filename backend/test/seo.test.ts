import assert from "node:assert/strict";
import test from "node:test";
import { PUBLIC_PAGES, SITE_ORIGIN, renderIndexHtml, robotsTxt, sitemapXml } from "../src/seo.js";

const HOST = new URL(SITE_ORIGIN).hostname;
const TEMPLATE = `<!doctype html><html><head>
    <meta name="description" content="old" />
    <title>Friday</title>
  </head><body><div id="root"></div></body></html>`;

test("public pages get their own title, description, canonical and no noindex", () => {
  const { status, html } = renderIndexHtml(TEMPLATE, "/build", HOST);
  assert.equal(status, 200);
  assert.match(html, new RegExp(`<title>${PUBLIC_PAGES["/build"].title}</title>`));
  assert.match(html, new RegExp(`<link rel="canonical" href="${SITE_ORIGIN}/build" />`));
  assert.doesNotMatch(html, /content="old"/);
  assert.doesNotMatch(html, /noindex/);
  assert.equal(html.match(/<meta name="description"/g)?.length, 1);
});

test("homepage carries structured data; trailing slashes normalise", () => {
  assert.match(renderIndexHtml(TEMPLATE, "/", HOST).html, /application\/ld\+json/);
  assert.match(renderIndexHtml(TEMPLATE, "/overview/", HOST).html, /<title>Overview/);
});

test("private app pages are served but noindexed", () => {
  const { status, html } = renderIndexHtml(TEMPLATE, "/c/868e3c40-68fc-44e2-a3c2-c191c5d19863", HOST);
  assert.equal(status, 200);
  assert.match(html, /noindex/);
  assert.doesNotMatch(html, /rel="canonical"/);
});

test("unknown paths return a real 404", () => {
  assert.equal(renderIndexHtml(TEMPLATE, "/definitely-not-a-page", HOST).status, 404);
});

test("the non-canonical (Railway) host is never indexed", () => {
  assert.match(renderIndexHtml(TEMPLATE, "/build", "friday-production-ce1a.up.railway.app").html, /noindex/);
  assert.equal(robotsTxt("friday-production-ce1a.up.railway.app"), "User-agent: *\nDisallow: /\n");
});

test("robots.txt points at the sitemap, and the sitemap lists every public page", () => {
  assert.match(robotsTxt(HOST), new RegExp(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`));
  const xml = sitemapXml(new Date("2026-09-28T00:00:00Z"));
  for (const p of Object.keys(PUBLIC_PAGES)) assert.ok(xml.includes(`<loc>${SITE_ORIGIN}${p}</loc>`), p);
});

test("the interactive gallery is a public, indexable page (not a soft 404)", () => {
  for (const path of ["/gallery", "/gallery/offside", "/gallery/emi", "/gallery/projectile"]) {
    const { status, html } = renderIndexHtml(TEMPLATE, path, HOST);
    assert.equal(status, 200, path);
    assert.ok(!html.includes("noindex"), `${path} is indexable`);
  }
  assert.ok(sitemapXml(new Date()).includes("/gallery/offside"));
  assert.equal(renderIndexHtml(TEMPLATE, "/gallery/nope", HOST).status, 404);
});
