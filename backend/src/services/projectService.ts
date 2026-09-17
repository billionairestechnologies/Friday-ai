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
) {
  const { data, error } = await supabaseAdmin
    .from("assistant_projects")
    .insert({
      user_id: userId,
      name,
      mode,
      instructions,
      repository_url: repositoryUrl,
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
