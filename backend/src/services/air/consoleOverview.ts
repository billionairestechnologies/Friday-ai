import { supabaseAdmin } from "../../config/supabase.js";
import { userLabels } from "../console/directory.js";
import { monthOf } from "../phone/store.js";

/**
 * Team Console → Phone → Air Dots: what is running, what waits on people, the calls, and what the gate
 * refused. Support can see a call and a job on the same account because both wrote to the same tables.
 */
export async function airOverview() {
  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const [running, waiting, callsToday, minutes, jobs, calls, refused] = await Promise.all([
    supabaseAdmin.from("air_jobs").select("id", { count: "exact", head: true }).eq("status", "running"),
    supabaseAdmin.from("air_jobs").select("id", { count: "exact", head: true }).in("status", ["needs_approval", "needs_login"]),
    supabaseAdmin.from("air_calls").select("id", { count: "exact", head: true }).gte("created_at", since),
    supabaseAdmin.from("phone_minutes").select("seconds").eq("month", monthOf()),
    supabaseAdmin.from("air_jobs").select("id, user_id, task, status, summary, rounds, source, created_at").order("created_at", { ascending: false }).limit(40),
    supabaseAdmin.from("air_calls").select("id, user_id, direction, trunk, status, seconds, summary, created_at").order("created_at", { ascending: false }).limit(40),
    supabaseAdmin.from("air_actions").select("id, user_id, kind, name, detail, created_at").eq("decision", "refused").order("created_at", { ascending: false }).limit(40),
  ]);
  const ids = [...(jobs.data ?? []), ...(calls.data ?? []), ...(refused.data ?? [])].map((r) => r.user_id as string);
  const labels = await userLabels(ids);
  const who = (id: string) => labels[id]?.name ?? labels[id]?.email ?? id.slice(0, 8);
  return {
    stats: {
      runningJobs: running.count ?? 0,
      waitingOnPeople: waiting.count ?? 0,
      callsLast24h: callsToday.count ?? 0,
      callMinutesThisMonth: Math.round(((minutes.data ?? []) as { seconds: number }[]).reduce((n, r) => n + (r.seconds ?? 0), 0) / 60),
    },
    jobs: (jobs.data ?? []).map((r) => ({ ...r, user: who(r.user_id as string) })),
    calls: (calls.data ?? []).map((r) => ({ ...r, user: who(r.user_id as string) })),
    refused: (refused.data ?? []).map((r) => ({ ...r, user: who(r.user_id as string) })),
  };
}
