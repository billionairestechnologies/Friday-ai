import { lookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";

/**
 * Server-side HTTP GET for model-chosen URLs (the `fetch_url` tool). A model can be steered by a
 * hostile page or prompt into requesting internal addresses (cloud metadata at 169.254.169.254,
 * localhost admin ports, the private network), so every connection is checked at the socket level:
 * the DNS lookup used for the actual connection rejects private/reserved addresses (which also
 * defeats DNS rebinding — there is no separate "check, then fetch" window), IP-literal hosts are
 * checked up front, and each redirect hop goes through the same checks.
 */

const MAX_REDIRECTS = 4;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 3 * 1024 * 1024;

export class BlockedUrlError extends Error {}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

function inV4Range(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const BLOCKED_V4: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/** True for loopback, private, link-local, CGNAT, multicast, documentation and other non-public addresses. */
export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return BLOCKED_V4.some(([base, bits]) => inV4Range(address, base, bits));
  if (family === 6) {
    const a = address.toLowerCase();
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]!);
    if (a === "::" || a === "::1") return true;
    const first = parseInt(a.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    if (a.startsWith("64:ff9b:") || a.startsWith("2001:db8:")) return true; // NAT64 / documentation
    return false;
  }
  return true; // not an IP at all — never connect to it
}

/** Validates scheme/port/host of a URL before any connection is attempted. */
export function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError("That is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedUrlError("Only http(s) URLs can be fetched");
  if (url.username || url.password) throw new BlockedUrlError("URLs with credentials are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new BlockedUrlError("Internal hosts cannot be fetched");
  }
  if (net.isIP(host) && isBlockedAddress(host)) throw new BlockedUrlError("Private or reserved addresses cannot be fetched");
  if (url.port && !["80", "443", "8080", "8443"].includes(url.port)) throw new BlockedUrlError("Only standard web ports can be fetched");
  return url;
}

const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 4);
    const list = addresses as unknown as { address: string; family: number }[];
    const bad = list.find((a) => isBlockedAddress(a.address));
    if (bad || list.length === 0) {
      return callback(new BlockedUrlError(`${hostname} resolves to a private or reserved address`), "", 4);
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
};

export type SafeResponse = { url: string; status: number; contentType: string; body: Buffer; truncated: boolean };

function requestOnce(url: URL, timeoutMs: number, maxBytes: number, signal?: AbortSignal): Promise<SafeResponse & { location?: string }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "GET",
        lookup: guardedLookup,
        timeout: timeoutMs,
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; FridayAI/1.0; +https://friday.ai)",
          Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5",
          "Accept-Encoding": "gzip, deflate, br",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          resolve({ url: url.toString(), status, contentType: "", body: Buffer.alloc(0), truncated: false, location });
          return;
        }
        const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
        let stream: NodeJS.ReadableStream = res;
        if (encoding === "gzip") stream = res.pipe(zlib.createGunzip());
        else if (encoding === "deflate") stream = res.pipe(zlib.createInflate());
        else if (encoding === "br") stream = res.pipe(zlib.createBrotliDecompress());
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        stream.on("data", (chunk: Buffer) => {
          if (truncated) return;
          size += chunk.length;
          if (size > maxBytes) {
            truncated = true;
            chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
            res.destroy();
            finish();
            return;
          }
          chunks.push(chunk);
        });
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve({
            url: url.toString(),
            status,
            contentType: String(res.headers["content-type"] ?? ""),
            body: Buffer.concat(chunks),
            truncated,
          });
        };
        stream.on("end", finish);
        stream.on("error", (err) => (truncated ? finish() : reject(err)));
      },
    );
    req.on("timeout", () => req.destroy(new Error("The page took too long to respond")));
    req.on("error", reject);
    req.end();
  });
}

export async function safeFetch(
  raw: string,
  opts: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {},
): Promise<SafeResponse> {
  let url = assertFetchableUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await requestOnce(url, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.maxBytes ?? DEFAULT_MAX_BYTES, opts.signal);
    if (!res.location) return res;
    url = assertFetchableUrl(new URL(res.location, url).toString());
  }
  throw new BlockedUrlError("Too many redirects");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (m, e: string) => {
    const key = e.toLowerCase();
    try {
      if (key.startsWith("#x")) return String.fromCodePoint(parseInt(key.slice(2), 16));
      if (key.startsWith("#")) return String.fromCodePoint(Number(key.slice(1)));
    } catch {
      return m; // out-of-range code point
    }
    return ENTITIES[key] ?? m;
  });
}

/** Readable text from an HTML page: drops scripts/styles/navigation chrome, keeps headings, paragraphs,
 *  list items and link targets as plain lines. Deliberately dependency-free. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim());
  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|iframe|template|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|footer|aside|form)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const main = body.match(/<(main|article)[^>]*>([\s\S]*?)<\/\1>/i)?.[2];
  if (main && main.replace(/<[^>]+>/g, "").trim().length > 400) body = main;
  const text = decodeEntities(body
    .replace(/<a\s[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const l = label.replace(/<[^>]+>/g, "").trim();
      return l ? `${l} (${href})` : "";
    })
    .replace(/<h([1-6])[^>]*>/gi, (_m, n: string) => `\n\n${"#".repeat(Number(n))} `)
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|h[1-6]|tr|table|ul|ol|blockquote|pre)>/gi, "\n")
    .replace(/<t[dh][^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}
