import { supabaseAdmin } from "../config/supabase.js";
import { logger } from "../utils/logger.js";

export type UsageEventType =
  | "chat_message"
  | "web_search"
  | "voice_second"
  | "sandbox_run"
  | "attachment_upload";

export async function recordUsageEvent(
  userId: string,
  eventType: UsageEventType,
  quantity = 1,
  metadata: Record<string, unknown> = {},
) {
  const { error } = await supabaseAdmin.from("usage_events").insert({
    user_id: userId,
    event_type: eventType,
    quantity,
    metadata,
  });
  if (error) {
    logger.warn("usage_event_failed", { userId, eventType, error: error.message });
  }
}

export async function usageSummary(userId: string) {
  const since = new Date();
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);

  const { data, error } = await supabaseAdmin
    .from("usage_events")
    .select("event_type, quantity, estimated_cost_cents")
    .eq("user_id", userId)
    .gte("created_at", since.toISOString());

  if (error) throw new Error(error.message);

  const totals = {
    chatMessages: 0,
    searches: 0,
    voiceSeconds: 0,
    sandboxRuns: 0,
    attachmentUploads: 0,
    estimatedCostCents: 0,
  };

  for (const row of data ?? []) {
    const quantity = Number(row.quantity ?? 0);
    totals.estimatedCostCents += Number(row.estimated_cost_cents ?? 0);
    if (row.event_type === "chat_message") totals.chatMessages += quantity;
    else if (row.event_type === "web_search") totals.searches += quantity;
    else if (row.event_type === "voice_second") totals.voiceSeconds += quantity;
    else if (row.event_type === "sandbox_run") totals.sandboxRuns += quantity;
    else if (row.event_type === "attachment_upload") totals.attachmentUploads += quantity;
  }

  return {
    periodStart: since.toISOString(),
    totals,
  };
}

export async function recordAdminAuditLog(
  actorUserId: string,
  action: string,
  targetType: string,
  targetId?: string,
  metadata: Record<string, unknown> = {},
) {
  const { error } = await supabaseAdmin.from("admin_audit_logs").insert({
    actor_user_id: actorUserId,
    action,
    target_type: targetType,
    target_id: targetId,
    metadata,
  });
  if (error) {
    logger.warn("admin_audit_log_failed", { actorUserId, action, targetType, error: error.message });
  }
}
