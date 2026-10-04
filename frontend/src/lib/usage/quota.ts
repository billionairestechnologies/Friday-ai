export type QuotaBucket = { used: number; limit: number; resetAt: string };

export type QuotaStatus = {
  plan: "free" | "pro" | "premium";
  isEnterprise: boolean;
  rolling: QuotaBucket | null;
  weekly: QuotaBucket;
  monthly: QuotaBucket | null;
  org: (QuotaBucket & { seatCount: number }) | null;
  memberCap: { used: number; limit: number } | null;
};

export type QuotaBreakdownEntry = { type: string; quantity: number; percent: number };

export type QuotaResponse = {
  status: QuotaStatus;
  breakdown: QuotaBreakdownEntry[];
  rollingBreakdown: QuotaBreakdownEntry[];
  monthlyBreakdown: QuotaBreakdownEntry[];
  /** What the user's plan / packages unlock (newer servers). */
  entitlements?: import("@/lib/billing/checkout").Entitlements | null;
};

export function percentUsed(bucket: { used: number; limit: number } | null): number {
  if (!bucket || bucket.limit <= 0) return 0;
  // Clamped both ways: an older server could still send a negative counter (bonus grants).
  return Math.max(0, Math.min(100, Math.round((bucket.used / bucket.limit) * 100)));
}

const EVENT_LABELS: Record<string, string> = {
  chat_message: "Chat",
  web_search: "Search",
  voice_second: "Voice",
  sandbox_run: "Build",
  attachment_upload: "Attachments",
  image_generation: "Image generation",
  // Cost-based breakdown (what the usage actually cost, by feature).
  chat: "Chat",
  build: "Build",
  research: "Deep Research",
  teamup: "Team Up",
  spark: "Spark",
  automation: "Automations",
  code: "Friday X",
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

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
  return String(Math.round(n));
}
