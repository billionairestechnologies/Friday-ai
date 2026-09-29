import { createHash } from "node:crypto";
import { env } from "../../config/env.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { logger } from "../../utils/logger.js";
import { memoAsync } from "../../utils/ttlMemo.js";
import { brandedEmail, fromAddress, mailConfigured, renderMarkdown, sendEmail } from "../console/mail.js";
import { userLabels } from "../console/directory.js";
import { createTicket } from "../console/supportService.js";
import { getRedisClient, redisConfigured, redisPing } from "../redisClient.js";
import { getProviderAdapter } from "../providers/registry.js";
import { getWorkingKeyForProvider, listChatCandidates } from "../providerService.js";

/**
 * The public status page (/status) and everything behind it:
 *  - probes: every 5 minutes each component (API, database, usage limits, email, every model
 *    provider with a working key) is checked and the result stored, which gives real uptime;
 *  - model uptime from REAL traffic: each chat turn records whether its model answered, so a model
 *    that's up for health checks but failing requests still shows as degraded;
 *  - incidents: opened by the team from the console, or automatically when a component fails two
 *    probes in a row (and closed when it recovers) — with an email alert to the team;
 *  - problem reports (become support tickets + an alert email) and crash reports from the apps.
 */

export type ComponentStatus = "operational" | "degraded" | "outage" | "unknown";
type Probe = { id: string; name: string; group: "Platform" | "Models"; core: boolean; run: () => Promise<void> };

const PROBE_TIMEOUT_MS = 8_000;
const PROBE_INTERVAL_MS = 5 * 60_000;
const RETENTION_DAYS = 120;

function withTimeout<T>(p: Promise<T>, ms = PROBE_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timed out")), ms)))]).finally(() => clearTimeout(timer));
}

const PLATFORM_NAMES: Record<string, string> = {
  api: "Friday app & API",
  database: "Database",
  cache: "Usage limits & sessions",
  email: "Email delivery",
};

async function buildProbes(): Promise<Probe[]> {
  const probes: Probe[] = [
    { id: "api", name: PLATFORM_NAMES.api!, group: "Platform", core: true, run: async () => {} },
    {
      id: "database",
      name: PLATFORM_NAMES.database!,
      group: "Platform",
      core: true,
      run: async () => {
        const { error } = await supabaseAdmin.from("providers").select("id", { count: "exact", head: true });
        if (error) throw new Error(error.message);
      },
    },
  ];
  if (redisConfigured()) {
    probes.push({
      id: "cache",
      name: PLATFORM_NAMES.cache!,
      group: "Platform",
      core: true,
      run: async () => {
        const r = await redisPing();
        if (r !== "ok") throw new Error(String(r));
      },
    });
  }
  if (mailConfigured()) {
    probes.push({
      id: "email",
      name: PLATFORM_NAMES.email!,
      group: "Platform",
      core: false,
      run: async () => {
        // Cheapest authenticated call; proves the key works and Resend answers.
        const res = await fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${env.resendApiKey}` } });
        if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      },
    });
  }
  // One probe per provider that actually serves users (has an enabled chat model and a working key).
  const candidates = await listChatCandidates().catch(() => []);
  const providers = new Map<string, string>();
  for (const c of candidates) providers.set(c.slug, c.providerDisplayName);
  for (const [slug, name] of providers) {
    probes.push({
      id: `model:${slug}`,
      name,
      group: "Models",
      core: false,
      run: async () => {
        const key = await getWorkingKeyForProvider(slug);
        const result = await getProviderAdapter(slug).healthCheck(key);
        if (!result.ok) throw new Error(result.error ?? "health check failed");
      },
    });
  }
  return probes;
}

let lastProbes: Probe[] = [];

export async function runProbes(): Promise<{ component: string; ok: boolean; latencyMs: number; error?: string }[]> {
  const probes = await buildProbes();
  lastProbes = probes;
  const results = await Promise.all(
    probes.map(async (probe) => {
      const started = Date.now();
      try {
        await withTimeout(probe.run());
        return { component: probe.id, ok: true, latencyMs: Date.now() - started };
      } catch (err) {
        return { component: probe.id, ok: false, latencyMs: Date.now() - started, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
      }
    }),
  );
  const { error } = await supabaseAdmin
    .from("status_checks")
    .insert(results.map((r) => ({ component: r.component, ok: r.ok, latency_ms: r.latencyMs, error: r.error ?? null })));
  if (error) logger.warn("status_checks_insert_failed", { error: error.message });
  else await reactToResults(probes, results).catch((err) => logger.warn("status_auto_incident_failed", { error: String(err) }));
  getPublicStatus.invalidate("status");
  return results;
}

/** Two failures in a row open an automatic incident (and alert the team); two passes close it. */
async function reactToResults(probes: Probe[], results: { component: string; ok: boolean; error?: string }[]) {
  const { data: open } = await supabaseAdmin.from("status_incidents").select("id, components").eq("auto", true).neq("status", "resolved");
  const openFor = new Map((open ?? []).flatMap((i) => (i.components as string[]).map((c) => [c, i.id as string] as const)));
  for (const result of results) {
    const { data: recent } = await supabaseAdmin.from("status_checks").select("ok").eq("component", result.component).order("checked_at", { ascending: false }).limit(2);
    const lastTwo = (recent ?? []).map((r) => r.ok as boolean);
    if (lastTwo.length < 2) continue;
    const probe = probes.find((p) => p.id === result.component);
    const incidentId = openFor.get(result.component);
    if (!lastTwo[0] && !lastTwo[1] && !incidentId && probe) {
      const incident = await createIncident(
        {
          title: `${probe.name} ${probe.core ? "is unavailable" : "is having problems"}`,
          status: "investigating",
          impact: probe.core ? "major" : "minor",
          components: [probe.id],
          body: `Our monitoring detected that ${probe.name} is failing health checks. We're looking into it.`,
          auto: true,
        },
        null,
      );
      void alertTeam(`🔴 ${incident.title}`, `Automatic incident opened.\n\n**Component:** ${probe.name}\n\n**Last error:** ${result.error ?? "unknown"}\n\nManage it in the Team Console → Status.`);
    } else if (lastTwo[0] && lastTwo[1] && incidentId) {
      await addIncidentUpdate(incidentId, { status: "resolved", body: `${probe?.name ?? result.component} has recovered and is passing health checks again.` }, null);
      void alertTeam(`✅ Recovered: ${probe?.name ?? result.component}`, "The automatic incident was resolved.");
    }
  }
}

let monitor: NodeJS.Timeout | null = null;
export function startStatusMonitor(intervalMs = PROBE_INTERVAL_MS) {
  if (monitor || process.env.FRIDAY_DISABLE_STATUS_MONITOR) return;
  let runs = 0;
  const tick = async () => {
    await runProbes().catch((err) => logger.warn("status_probe_run_failed", { error: String(err) }));
    // Prune once a day-ish (every 288 runs at the 5-minute default).
    if (runs++ % 288 === 0) {
      const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
      await supabaseAdmin.from("status_checks").delete().lt("checked_at", cutoff);
      await supabaseAdmin.from("crash_reports").delete().lt("created_at", cutoff);
    }
  };
  monitor = setInterval(() => void tick(), intervalMs);
  monitor.unref?.();
  setTimeout(() => void tick(), 20_000).unref?.();
}

// ── Model uptime from real traffic ───────────────────────────────────────────

function hourKey(date = new Date()): string {
  return `status:models:${date.toISOString().slice(0, 13)}`;
}

/** Called once per chat turn with the model that answered (or failed). Never throws. */
export async function recordModelOutcome(slug: string, modelId: string, ok: boolean): Promise<void> {
  try {
    const redis = await getRedisClient();
    if (!redis) return;
    const key = hourKey();
    await redis.hIncrBy(key, `${slug}|${modelId}|${ok ? "ok" : "err"}`, 1);
    await redis.expire(key, 26 * 3600);
  } catch {
    // status bookkeeping must never affect a chat turn
  }
}

async function modelTraffic(): Promise<Map<string, { ok: number; err: number }>> {
  const totals = new Map<string, { ok: number; err: number }>();
  const redis = await getRedisClient().catch(() => null);
  if (!redis) return totals;
  const now = Date.now();
  const hashes = await Promise.all(Array.from({ length: 24 }, (_, i) => redis.hGetAll(hourKey(new Date(now - i * 3600_000))).catch(() => ({}))));
  for (const hash of hashes) {
    for (const [field, value] of Object.entries(hash as Record<string, string>)) {
      const [slug, modelId, kind] = field.split("|");
      const key = `${slug}|${modelId}`;
      const entry = totals.get(key) ?? { ok: 0, err: 0 };
      if (kind === "ok") entry.ok += Number(value) || 0;
      else entry.err += Number(value) || 0;
      totals.set(key, entry);
    }
  }
  return totals;
}

// ── Incidents ────────────────────────────────────────────────────────────────

export type IncidentStatus = "investigating" | "identified" | "monitoring" | "resolved";
export type IncidentInput = { title: string; status: IncidentStatus; impact: "none" | "minor" | "major" | "critical"; components: string[]; body: string; auto?: boolean };

export async function createIncident(input: IncidentInput, actorId: string | null) {
  const { data, error } = await supabaseAdmin
    .from("status_incidents")
    .insert({
      title: input.title,
      status: input.status,
      impact: input.impact,
      components: input.components,
      auto: input.auto ?? false,
      resolved_at: input.status === "resolved" ? new Date().toISOString() : null,
      created_by: actorId,
    })
    .select()
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Couldn't open the incident");
  await supabaseAdmin.from("status_incident_updates").insert({ incident_id: data.id, status: input.status, body: input.body, author_id: actorId });
  getPublicStatus.invalidate("status");
  return data as { id: string; title: string };
}

export async function addIncidentUpdate(incidentId: string, input: { status: IncidentStatus; body: string; title?: string; impact?: IncidentInput["impact"] }, actorId: string | null) {
  const patch: Record<string, unknown> = { status: input.status, updated_at: new Date().toISOString(), resolved_at: input.status === "resolved" ? new Date().toISOString() : null };
  if (input.title) patch.title = input.title;
  if (input.impact) patch.impact = input.impact;
  const { error } = await supabaseAdmin.from("status_incidents").update(patch).eq("id", incidentId);
  if (error) throw new HttpError(500, error.message);
  await supabaseAdmin.from("status_incident_updates").insert({ incident_id: incidentId, status: input.status, body: input.body, author_id: actorId });
  getPublicStatus.invalidate("status");
}

export async function deleteIncident(incidentId: string) {
  const { error } = await supabaseAdmin.from("status_incidents").delete().eq("id", incidentId);
  if (error) throw new HttpError(500, error.message);
  getPublicStatus.invalidate("status");
}

export async function listIncidents(days = 90) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("status_incidents")
    .select("id, title, status, impact, components, auto, started_at, resolved_at, status_incident_updates(id, status, body, created_at)")
    .or(`started_at.gte.${since},status.neq.resolved`)
    .order("started_at", { ascending: false })
    .limit(100);
  if (error) throw new HttpError(500, error.message);
  return (data ?? []).map((i) => ({
    id: i.id as string,
    title: i.title as string,
    status: i.status as IncidentStatus,
    impact: i.impact as IncidentInput["impact"],
    components: i.components as string[],
    auto: i.auto as boolean,
    startedAt: i.started_at as string,
    resolvedAt: i.resolved_at as string | null,
    updates: ((i.status_incident_updates as { id: string; status: string; body: string; created_at: string }[]) ?? [])
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((u) => ({ id: u.id, status: u.status, body: u.body, createdAt: u.created_at })),
  }));
}

// ── Public status ────────────────────────────────────────────────────────────

type DailyRow = { component: string; day: string; total: number; ok: number; avg_latency_ms: number | null };

export function componentStatusFrom(latest: { ok: boolean }[], hasOpenIncident: boolean): ComponentStatus {
  if (!latest.length) return "unknown";
  if (!latest[0]!.ok && latest[1] && !latest[1].ok) return "outage";
  if (!latest[0]!.ok || hasOpenIncident) return "degraded";
  return "operational";
}

export function uptimePercent(rows: { total: number; ok: number }[]): number | null {
  const total = rows.reduce((n, r) => n + Number(r.total), 0);
  if (!total) return null;
  return Math.round((rows.reduce((n, r) => n + Number(r.ok), 0) / total) * 10_000) / 100;
}

function nameFor(component: string, providerNames: Map<string, string>): string {
  if (component.startsWith("model:")) return providerNames.get(component.slice(6)) ?? component.slice(6);
  return PLATFORM_NAMES[component] ?? component;
}

async function loadPublicStatus() {
  const [daily, incidents, candidates, traffic, latestRes] = await Promise.all([
    supabaseAdmin.rpc("status_daily", { p_days: 90 }),
    listIncidents(90).catch(() => []),
    listChatCandidates().catch(() => []),
    modelTraffic(),
    supabaseAdmin.from("status_checks").select("component, ok, latency_ms, checked_at").gte("checked_at", new Date(Date.now() - 30 * 60_000).toISOString()).order("checked_at", { ascending: false }).limit(500),
  ]);
  const providerNames = new Map(candidates.map((c) => [c.slug, c.providerDisplayName]));
  const rows = (daily.data as DailyRow[] | null) ?? [];
  const latest = (latestRes.data ?? []) as { component: string; ok: boolean; latency_ms: number | null; checked_at: string }[];
  const active = incidents.filter((i) => i.status !== "resolved");
  const componentIds = [...new Set([...rows.map((r) => r.component), ...latest.map((l) => l.component), ...lastProbes.map((p) => p.id)])];
  // Components that disappeared (a provider removed) keep history but aren't listed without recent data.
  const listed = componentIds.filter((id) => latest.some((l) => l.component === id) || lastProbes.some((p) => p.id === id));

  const today = new Date();
  const days = Array.from({ length: 90 }, (_, i) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (89 - i))).toISOString().slice(0, 10));
  const components = listed
    .map((id) => {
      const history = rows.filter((r) => r.component === id);
      const recent = latest.filter((l) => l.component === id);
      const openIncident = active.some((i) => i.components.includes(id));
      return {
        id,
        name: nameFor(id, providerNames),
        group: id.startsWith("model:") ? "Models" : "Platform",
        status: componentStatusFrom(recent, openIncident),
        latencyMs: recent.find((r) => r.ok)?.latency_ms ?? null,
        uptime90: uptimePercent(history),
        days: days.map((day) => {
          const row = history.find((r) => String(r.day).slice(0, 10) === day);
          return { date: day, uptime: row ? uptimePercent([row]) : null };
        }),
      };
    })
    .sort((a, b) => (a.group === b.group ? (a.group === "Platform" ? Object.keys(PLATFORM_NAMES).indexOf(a.id) - Object.keys(PLATFORM_NAMES).indexOf(b.id) : a.name.localeCompare(b.name)) : a.group === "Platform" ? -1 : 1));

  const models = candidates
    .map((c) => {
      const t = traffic.get(`${c.slug}|${c.modelId}`) ?? { ok: 0, err: 0 };
      const requests = t.ok + t.err;
      return {
        id: `${c.slug}/${c.modelId}`,
        name: c.displayName,
        provider: c.providerDisplayName,
        slug: c.slug,
        requests24h: requests,
        successRate24h: requests ? Math.round((t.ok / requests) * 1000) / 10 : null,
        status: (requests >= 5 && t.ok / requests < 0.5 ? "outage" : requests >= 5 && t.ok / requests < 0.9 ? "degraded" : components.find((x) => x.id === `model:${c.slug}`)?.status ?? "unknown") as ComponentStatus,
      };
    })
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));

  const coreDown = components.some((c) => c.group === "Platform" && c.status === "outage");
  const anyIssue = components.some((c) => c.status === "outage" || c.status === "degraded") || active.length > 0;
  const overall: ComponentStatus = coreDown || active.some((i) => i.impact === "critical") ? "outage" : anyIssue ? "degraded" : components.length ? "operational" : "unknown";

  return {
    overall,
    updatedAt: latest[0]?.checked_at ?? null,
    components,
    models,
    incidents: { active, recent: incidents.filter((i) => i.status === "resolved").slice(0, 20) },
  };
}

export const getPublicStatus = memoAsync(30_000, loadPublicStatus, () => "status");

// ── Alerts, problem reports, crashes ─────────────────────────────────────────

async function alertRecipients(): Promise<string[]> {
  if (env.statusAlertEmails.length) return env.statusAlertEmails;
  const { data: identity } = await supabaseAdmin.from("mail_identities").select("address").eq("purpose", "support").limit(1).maybeSingle();
  if (identity?.address) return [identity.address as string];
  const { data: owners } = await supabaseAdmin.from("staff_members").select("user_id").in("role_id", ["owner", "admin"]).eq("active", true).limit(10);
  const labels = await userLabels((owners ?? []).map((o) => o.user_id as string));
  return Object.values(labels).map((l) => l.email).filter((e): e is string => Boolean(e));
}

export async function alertTeam(subject: string, markdown: string): Promise<void> {
  if (!mailConfigured()) return;
  try {
    const [to, from] = await Promise.all([alertRecipients(), fromAddress({ purpose: "support" })]);
    const html = brandedEmail({ heading: subject, bodyHtml: renderMarkdown(markdown) });
    await Promise.all(to.map((address) => sendEmail({ ...from, to: address, subject: `[Friday status] ${subject}`, html })));
  } catch (err) {
    logger.warn("status_alert_failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function submitProblemReport(input: { userId: string | null; email: string; name: string; description: string; component?: string | null; url?: string | null; userAgent?: string | null }) {
  const componentName = input.component ? nameFor(input.component, new Map((await listChatCandidates().catch(() => [])).map((c) => [c.slug, c.providerDisplayName]))) : null;
  const body = [
    input.description.trim(),
    "",
    "---",
    componentName ? `Affected: ${componentName}` : null,
    input.url ? `Page: ${input.url}` : null,
    input.userAgent ? `Browser: ${input.userAgent.slice(0, 200)}` : null,
  ]
    .filter((l) => l !== null)
    .join("\n");
  const ticket = await createTicket({
    userId: input.userId,
    email: input.email,
    name: input.name,
    subject: `Problem report${componentName ? ` — ${componentName}` : ""}: ${input.description.trim().split("\n")[0]!.slice(0, 80)}`,
    body,
    category: "problem_report",
    channel: "web",
    priority: "high",
  });
  void alertTeam(`Problem reported${componentName ? `: ${componentName}` : ""}`, `**From:** ${input.name} <${input.email}>\n\n${input.description.slice(0, 2000)}\n\nTicket #${(ticket as { number?: number }).number ?? ""} is in the Team Console → Support.`);
  return ticket;
}

export function crashFingerprint(platform: string, message: string, stack?: string | null): string {
  // Digits, hex ids and quoted values vary per occurrence; the first stack frame (minus line:col)
  // is what makes two crashes "the same".
  const normalized = message.replace(/0x[0-9a-f]+|\b[0-9a-f]{8,}\b|\d+/gi, "#").replace(/(["'`]).*?\1/g, "…").slice(0, 300);
  const frame = (stack ?? "").split("\n").map((l) => l.trim()).find((l) => l.startsWith("at ") || l.includes("@"))?.replace(/:\d+:\d+\)?$/, "") ?? "";
  return createHash("sha1").update(`${platform}|${normalized}|${frame}`).digest("hex").slice(0, 16);
}

export async function recordCrash(input: { platform: "web" | "android" | "ios"; message: string; stack?: string | null; url?: string | null; userAgent?: string | null; release?: string | null; userId: string | null }) {
  const fingerprint = crashFingerprint(input.platform, input.message, input.stack);
  const { error } = await supabaseAdmin.from("crash_reports").insert({
    fingerprint,
    platform: input.platform,
    message: input.message.slice(0, 1000),
    stack: input.stack?.slice(0, 8000) ?? null,
    url: input.url?.slice(0, 500) ?? null,
    user_agent: input.userAgent?.slice(0, 300) ?? null,
    release: input.release?.slice(0, 60) ?? null,
    user_id: input.userId,
  });
  if (error) throw new HttpError(500, error.message);
  return { fingerprint };
}

export async function crashGroups(days = 14) {
  const { data, error } = await supabaseAdmin.rpc("crash_groups", { p_days: days });
  if (error) throw new HttpError(500, error.message);
  return data ?? [];
}

export async function crashSample(id: string) {
  const { data, error } = await supabaseAdmin.from("crash_reports").select("*").eq("id", id).maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, "Crash report not found");
  return data;
}
