/**
 * The browser daemon that runs INSIDE the E2B sandbox: a real headless Chromium (Playwright) kept
 * open between tool calls, driven over a localhost JSON endpoint. Shipped as a string and written
 * into the sandbox. Each action returns a snapshot: URL, title, the page's visible text and a
 * numbered list of the elements you can act on ([12] button "Sign in") — the model refers to
 * elements by those numbers, the way agent browsers do, instead of guessing CSS selectors.
 */
export const DAEMON_SOURCE = String.raw`
import http from "node:http";
import { chromium } from "playwright-core";

const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  locale: "en-IN",
});
let page = await context.newPage();
context.on("page", (p) => { page = p; });

async function settle() {
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(700);
}

async function snapshot() {
  const data = await page.evaluate(() => {
    document.querySelectorAll("[data-friday-ref]").forEach((e) => e.removeAttribute("data-friday-ref"));
    const sel = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=option],[contenteditable=true],summary';
    const out = [];
    let n = 0;
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      if (r.width < 2 || r.height < 2 || st.visibility === "hidden" || st.display === "none") continue;
      if (n >= 200) break;
      const ref = String(++n);
      el.setAttribute("data-friday-ref", ref);
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute("type") || "";
      const name = (el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || "").trim().replace(/\s+/g, " ").slice(0, 80);
      const extra = tag === "a" ? " -> " + (el.getAttribute("href") || "").slice(0, 100) : (tag === "input" || tag === "textarea") && el.value ? " value=" + JSON.stringify(String(el.value).slice(0, 40)) : "";
      out.push("[" + ref + "] " + tag + (type ? "(" + type + ")" : "") + " " + JSON.stringify(name) + extra);
    }
    const text = document.body ? document.body.innerText.replace(/\n{3,}/g, "\n\n").trim() : "";
    return { elements: out, text: text.slice(0, 9000), more: text.length > 9000 };
  });
  return { url: page.url(), title: await page.title(), ...data };
}

const el = (ref) => page.locator('[data-friday-ref="' + String(ref).replace(/[^0-9]/g, "") + '"]').first();

async function handle(cmd) {
  switch (cmd.action) {
    case "open":
      await page.goto(cmd.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      break;
    case "click":
      await el(cmd.ref).click({ timeout: 10000 });
      break;
    case "type":
      await el(cmd.ref).fill(String(cmd.text ?? ""), { timeout: 10000 });
      if (cmd.submit) await el(cmd.ref).press("Enter");
      break;
    case "select":
      await el(cmd.ref).selectOption({ label: String(cmd.value ?? "") }).catch(() => el(cmd.ref).selectOption(String(cmd.value ?? "")));
      break;
    case "press":
      await page.keyboard.press(String(cmd.key || "Enter"));
      break;
    case "scroll":
      await page.mouse.wheel(0, cmd.direction === "up" ? -700 : 700);
      break;
    // The Air Dots screen: the person drives the same page with a mouse or a finger.
    case "click_at":
      await page.mouse.click(Math.max(0, Math.min(1280, Number(cmd.x) || 0)), Math.max(0, Math.min(800, Number(cmd.y) || 0)));
      break;
    case "type_text":
      await page.keyboard.type(String(cmd.text ?? "").slice(0, 2000), { delay: 15 });
      break;
    case "back":
      await page.goBack({ timeout: 15000 }).catch(() => {});
      break;
    case "read":
      break;
    case "screenshot": {
      const buf = await page.screenshot({ type: "jpeg", quality: 60 });
      return { url: page.url(), title: await page.title(), image: buf.toString("base64") };
    }
    default:
      throw new Error("Unknown action " + cmd.action);
  }
  await settle();
  return snapshot();
}

let queue = Promise.resolve();
http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      queue = queue.then(async () => {
        try {
          if (req.url === "/health") return res.end("ok");
          const out = await handle(JSON.parse(body || "{}"));
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, ...out }));
        } catch (e) {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e).slice(0, 500), url: page.url() }));
        }
      });
    });
  })
  .listen(7777, "127.0.0.1");
`;
