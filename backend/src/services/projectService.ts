import { supabaseAdmin } from "../config/supabase.js";
import { HttpError } from "../middleware/errorHandler.js";

export type ProjectMode = "personal" | "work" | "developer";

export async function listProjects(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("assistant_projects")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  if (error) throw new HttpError(500, error.message);
  return data ?? [];
}

export async function createProject(
  userId: string,
  name: string,
  mode: ProjectMode,
  instructions = "",
  repositoryUrl: string | null = null,
  description = "",
) {
  const { data, error } = await supabaseAdmin
    .from("assistant_projects")
    .insert({
      user_id: userId,
      name,
      mode,
      instructions,
      repository_url: repositoryUrl,
      description,
    })
    .select()
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Failed to create project");
  return data;
}

export async function getOwnedProject(userId: string, projectId: string) {
  const { data, error } = await supabaseAdmin
    .from("assistant_projects")
    .select("*")
    .eq("id", projectId)
    .eq("user_id", userId)
    .single();
  if (error || !data) throw new HttpError(404, "Project not found");
  return data;
}

export type ProjectPatch = Partial<{
  name: string;
  mode: ProjectMode;
  instructions: string;
  repositoryUrl: string | null;
  description: string;
}>;

export async function updateProject(userId: string, projectId: string, patch: ProjectPatch) {
  await getOwnedProject(userId, projectId);
  const { data, error } = await supabaseAdmin
    .from("assistant_projects")
    .update({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
      ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
      ...(patch.repositoryUrl !== undefined ? { repository_url: patch.repositoryUrl } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", projectId)
    .select()
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Failed to update project");
  return data;
}

/**
 * Deleting a project doesn't delete its chats — conversations.project_id is ON DELETE SET NULL,
 * so any chats that were scoped to this project fall back into the user's general chat list
 * instead of being destroyed.
 */
export async function deleteProject(userId: string, projectId: string) {
  await getOwnedProject(userId, projectId);
  const { error } = await supabaseAdmin.from("assistant_projects").delete().eq("id", projectId);
  if (error) throw new HttpError(500, error.message);
}
