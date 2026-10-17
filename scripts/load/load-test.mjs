#!/usr/bin/env node
/**
 * Staged load test for a Friday STAGING environment (brief §30). Never production:
 *
 *   FRIDAY_LOAD_URL=https://friday-test.example.com \
 *   FRIDAY_LOAD_TOKENS=tokenA,tokenB,…   (access tokens of synthetic test accounts — one per simulated user, reused round-robin)
 *   node scripts/load/load-test.mjs [--stages 10,50,100,250] [--seconds 30] [--chat --max-chat-requests 200]
 *
 * Default workload is cheap and provider-free: GET /api/health, /api/usage/quota, /api/notifications.
 * --chat adds real chat turns (these COST provider money and tokens) and is capped by
 * --max-chat-requests. Reports per stage: requests, errors, rps, p50/p95/p99 latency and, for chat,
 * time to first streamed byte.
 */
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? def : (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true);
};
const base = (process.env.FRIDAY_LOAD_URL || "").replace(/\/$/, "");
const tokens = (process.env.FRIDAY_LOAD_TOKENS || "").split(",").map((t) => t.trim()).filter(Boolean);
const stages = String(flag("stages", "10,50,100,250")).split(",").map(Number).filter((n) => n > 0);
const seconds = Number(flag("seconds", 30));
const chat = Boolean(flag("chat", false));
const maxChat = Number(flag("max-chat-requests", 0));

const PROD = /(^|\.)friday\.billionairestechnologies\.com$/i;
if (!base) {
  console.error("Set FRIDAY_LOAD_URL to a STAGING base URL.");
  process.exit(2);
}
if (PROD.test(new URL(base).hostname)) {
  console.error("Refusing: that is the production site. Load tests run against staging only (brief §30).");
  process.exit(2);
}
if (!tokens.length) {
  console.error("Set FRIDAY_LOAD_TOKENS to access tokens of synthetic test accounts (comma-separated).");
  process.exit(2);
}
if (chat && !(maxChat > 0)) {
  console.error("--chat costs provider money: also pass --max-chat-requests N.");
  process.exit(2);
}

export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

let chatSent = 0;
const conversations = new Map();
/** One conversation per simulated user (POST /api/chat/conversations), reused for every chat turn. */
async function conversationFor(user, headers) {
  if (!conversations.has(user)) {
    const res = await fetch(`${base}/api/chat/conversations`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ title: "Load test" }) });
    const body = await res.json();
    conversations.set(user, body.conversation?.id ?? body.id);
  }
  return conversations.get(user);
}
async function one(user) {
  const token = tokens[user % tokens.length];
  const headers = { Authorization: `Bearer ${token}` };
  const paths = ["/api/health", "/api/usage/quota", "/api/notifications"];
  const doChat = chat && chatSent < maxChat && Math.random() < 0.2;
  const started = performance.now();
  try {
    if (doChat) {
      chatSent++;
      const conv = await conversationFor(user, headers);
      const res = await fetch(`${base}/api/chat/conversations/${conv}/messages/stream`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ content: "Reply with one short sentence: load test ping." }) });
      const reader = res.body.getReader();
      let first = null;
      for (;;) {
        const { done } = await reader.read();
        if (first === null) first = performance.now() - started;
        if (done) break;
      }
      return { ok: res.ok, ms: performance.now() - started, ttfb: first, kind: "chat" };
    }
    const res = await fetch(`${base}${paths[Math.floor(Math.random() * paths.length)]}`, { headers });
    await res.arrayBuffer();
    return { ok: res.ok, ms: performance.now() - started, kind: "read" };
  } catch {
    return { ok: false, ms: performance.now() - started, kind: doChat ? "chat" : "read" };
  }
}

async function stage(users) {
  const end = Date.now() + seconds * 1000;
  const results = [];
  await Promise.all(
    Array.from({ length: users }, async (_, u) => {
      while (Date.now() < end) results.push(await one(u));
    }),
  );
  const lat = results.map((r) => r.ms).sort((a, b) => a - b);
  const ttfb = results.filter((r) => r.ttfb != null).map((r) => r.ttfb).sort((a, b) => a - b);
  return {
    users,
    requests: results.length,
    errors: results.filter((r) => !r.ok).length,
    rps: Math.round((results.length / seconds) * 10) / 10,
    p50: Math.round(percentile(lat, 50)),
    p95: Math.round(percentile(lat, 95)),
    p99: Math.round(percentile(lat, 99)),
    chatTurns: ttfb.length,
    ttfbP95: ttfb.length ? Math.round(percentile(ttfb, 95)) : null,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`Load test → ${base} · stages ${stages.join(" → ")} users · ${seconds}s each${chat ? ` · chat capped at ${maxChat}` : " · no chat (provider-free)"}`);
  const rows = [];
  for (const users of stages) {
    const r = await stage(users);
    rows.push(r);
    console.log(JSON.stringify(r));
    // Stop climbing when the system is clearly failing — the point is to find the limit, not to flood it.
    if (r.errors / Math.max(1, r.requests) > 0.05) {
      console.log(`Stopping: ${((r.errors / r.requests) * 100).toFixed(1)}% errors at ${users} users.`);
      break;
    }
  }
  console.table(rows);
}
