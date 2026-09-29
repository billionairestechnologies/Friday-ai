import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { userLabels } from "./directory.js";

/** Shared team tasks — anyone with tasks.manage can create and assign to anyone, optionally linked to a ticket or contact. */

export type TaskInput = {
  title: string;
  description?: string;
  status?: "todo" | "in_progress" | "done";
  priority?: "low" | "normal" | "high" | "urgent";
  assigneeId?: string | null;
  dueAt?: string | null;
  relatedType?: "ticket" | "contact" | null;
  relatedId?: string | null;
};

function toRow(input: Partial<TaskInput>) {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.title !== undefined) row.title = input.title;
  if (input.description !== undefined) row.description = input.description;
  if (input.status !== undefined) {
    row.status = input.status;
    row.completed_at = input.status === "done" ? new Date().toISOString() : null;
  }
  if (input.priority !== undefined) row.priority = input.priority;
  if (input.assigneeId !== undefined) row.assignee_id = input.assigneeId || null;
  if (input.dueAt !== undefined) row.due_at = input.dueAt || null;
  if (input.relatedType !== undefined) row.related_type = input.relatedType || null;
  if (input.relatedId !== undefined) row.related_id = input.relatedId || null;
  return row;
}

export async function listTasks(filter: { assigneeId?: string; status?: string; relatedId?: string }) {
  let query = supabaseAdmin.from("staff_tasks").select("*").order("created_at", { ascending: false }).limit(500);
  if (filter.assigneeId) query = query.eq("assignee_id", filter.assigneeId);
  if (filter.status) query = query.eq("status", filter.status);
  if (filter.relatedId) query = query.eq("related_id", filter.relatedId);
  const { data, error } = await query;
  if (error) throw new HttpError(500, error.message);
  const labels = await userLabels((data ?? []).flatMap((t) => [t.assignee_id as string | null, t.created_by as string | null]));
  return (data ?? []).map((t) => ({
    ...t,
    assignee: t.assignee_id ? labels[t.assignee_id as string] ?? null : null,
    creator: t.created_by ? labels[t.created_by as string] ?? null : null,
  }));
}

export async function createTask(input: TaskInput, actorId: string) {
  const { data, error } = await supabaseAdmin.from("staff_tasks").insert({ ...toRow(input), created_by: actorId }).select().single();
  if (error || !data) throw new HttpError(400, error?.message ?? "Couldn't create the task");
  return data;
}

export async function updateTask(id: string, input: Partial<TaskInput>) {
  const { data, error } = await supabaseAdmin.from("staff_tasks").update(toRow(input)).eq("id", id).select().single();
  if (error || !data) throw new HttpError(404, "Task not found");
  return data;
}

export async function deleteTask(id: string) {
  const { error } = await supabaseAdmin.from("staff_tasks").delete().eq("id", id);
  if (error) throw new HttpError(500, error.message);
}
