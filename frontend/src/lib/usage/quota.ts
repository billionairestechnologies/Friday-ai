export type QuotaBucket = { used: number; limit: number; resetAt: string };

/** The current subscription period, straight from the server's ledger (GET /usage/quota). */
export type QuotaPeriod = {
  accountId: string;
  start: string;
  end: string;
  /** Tokens this period (the plan's monthly allowance, or a package's). */
  allowance: number;
  /** Finalized usage recorded in the ledger. */
  used: number;
  /** Net admin adjustments: negative = tokens given back (bonus, refund), positive = debited. */
  adjustments: number;
  /** Held right now for requests still running. */
  reserved: number;
  /** Unspent bonus credits (on top of the allowance; they outlive the month, each grant has its own expiry). */
  credits?: number;
  /** This period's usage that bonus credits paid for (usage past the month's allowance). */
  creditDrawn?: number;
  /** What can still be spent: the month's allowance left + bonus credits − requests in progress (never below 0). */
  remaining: number;
  status: "active" | "suspended";
  subscription: "free" | "active" | "expired" | "suspended";
  renewsAt: string | null;
  pendingPlan: string | null;
};

export type QuotaStatus = {
  plan: "free" | "pro" | "premium";
  isEnterprise: boolean;
  /** Newer servers; older ones only send the buckets below. */
  period?: QuotaPeriod;
  monthly: QuotaBucket | null;
  /** Retired (always null since the monthly allowance) — kept so older cached payloads still parse. */
  rolling: QuotaBucket | null;
  weekly: QuotaBucket | null;
  org: (QuotaBucket & { seatCount: number }) | null;
  memberCap: { used: number; limit: number } | null;
};

export type QuotaBreakdownEntry = { type: string; quantity: number; percent: number };

export type UsageReport = {
  totals: { calls: number; billable: number; input: number; output: number; cached: number; reasoning: number; estimatedBillable: number };
  byModel: Array<{ model: string; vendor: string; calls: number; billable: number; input: number; output: number; cached: number; reasoning: number; estimatedBillable: number }>;
  byFeature: Array<{ feature: string; calls: number; billable: number }>;
  byDay: Array<{ day: string; billable: number }>;
  recent: Array<{ at: string; model: string; feature: string; input: number; output: number; billable: number; source: string; status: string }>;
  adjustments: Array<{ at: string; kind: string; tokens: number; reason: string }>;
};

export type QuotaResponse = {
  status: QuotaStatus;
  report?: UsageReport;
  thresholds?: number[];
  breakdown: QuotaBreakdownEntry[];
  monthlyBreakdown: QuotaBreakdownEntry[];
  /** What the user's plan / packages unlock (newer servers). */
  entitlements?: import("@/lib/billing/checkout").Entitlements | null;
};

export function percentUsed(bucket: { used: number; limit: number } | null): number {
  if (!bucket || bucket.limit <= 0) return 0;
  // Clamped both ways: bonuses can push usage below 0, an in-flight call can overrun the last tokens.
  return Math.max(0, Math.min(100, Math.floor((bucket.used / bucket.limit) * 100)));
}

/** The one balance every screen shows: the server's period (or, from an older server, the monthly / org bucket). */
export function mainBucket(status: QuotaStatus): QuotaBucket | null {
  if (status.period) return { used: Math.max(0, status.period.used + status.period.adjustments), limit: status.period.allowance, resetAt: status.period.end };
  return status.org ?? status.monthly ?? null;
}

const EVENT_LABELS: Record<string, string> = {
  chat_message: "Chat",
  web_search: "Search",
  voice_second: "Voice",
  sandbox_run: "Build",
  attachment_upload: "Attachments",
  image_generation: "Image generation",
  chat: "Chat",
  build: "Build",
  research: "Deep Research",
  teamup: "Team Up",
  spark: "Spark",
  automation: "Automations",
  code: "FridayX",
};

export function labelForEventType(type: string): string {
  return EVENT_LABELS[type] ?? type;
}

export function formatResetAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Compact token count: 2,450,000 → "2.45M", 12,300 → "12.3K". Exact integers stay in the data. */
export function formatTokens(n: number): string {
  const v = Math.max(0, Math.round(n));
  const trim = (x: number, digits: number) => x.toFixed(digits).replace(/\.?0+$/, "");
  if (v >= 1_000_000) return `${trim(v / 1_000_000, 2)}M`;
  if (v >= 1_000) return `${trim(v / 1_000, 1)}K`;
  return String(v);
}

/** "2.45M / 10M tokens". */
export function formatUsedOf(used: number, limit: number): string {
  return `${formatTokens(used)} / ${formatTokens(limit)} tokens`;
}
