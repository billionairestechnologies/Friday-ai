import { Sandbox } from "@e2b/code-interpreter";
import { env } from "../../config/env.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { getRedisClient } from "../redisClient.js";
import { entitlementsFor } from "../quota/entitlements.js";
import { usedCallSeconds } from "../phone/store.js";
import { airMachineId, pauseAirMachine } from "../browser/session.js";
import { stopAirJob } from "./jobs.js";

/**
 * Team Console → Users → a person's Air Dots: their computer (awake or paused), today's awake minutes
 * against the cap, call minutes, passphrase state, linked channels, dots and the running job — and the
 * three things support needs to do: pause the computer (the dot stops, work kept), stop jobs, unlock
 * a passphrase lockout.
 */
export async function userAirStatus(userId: string) {
  const redis = await getRedisClient().catch(() => null);
  const day = new Date().toISOString().slice(0, 10);
  const [ents, callSeconds, profile, channels, dots, jobs, machine, awakeUsed, awakeUntil] = await Promise.all([
    entitlementsFor(userId),
    usedCallSeconds(userId),
    supabaseAdmin.from("profiles").select("*").eq("id", userId).maybeSingle(),
    supabaseAdmin.from("air_channels").select("channel, external_id, created_at").eq("user_id", userId),
    supabaseAdmin.from("air_dots").select("id, name, conversation_id").eq("user_id", userId).order("sort"),
    supabaseAdmin.from("air_jobs").select("id, conversation_id, task, status, rounds, created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(10),
    airMachineId(userId),
    redis ? redis.get(`allow:air_awake:${userId}:${day}`) : Promise.resolve(null),
    redis ? redis.get(`air:awake:machine:${userId}`) : Promise.resolve(null),
  ]);
  const p = (profile.data ?? {}) as { air_passphrase_hash?: string | null; air_passphrase_locked_until?: string | null; air_passphrase_failures?: number | null; phone?: string | null };
  const until = Number(awakeUntil ?? 0);
  return {
    enabled: ents.airDots,
    computer: { sandboxId: machine, awake: until > Date.now(), awakeUntil: until > Date.now() ? new Date(until).toISOString() : null },
    awake: { usedMinutes: Number(awakeUsed ?? 0), capMinutes: ents.airAwakeMinutes },
    calls: { usedMinutes: Math.ceil(callSeconds / 60), limitMinutes: ents.airCallMinutes, phone: p.phone ?? null },
    passphrase: {
      set: Boolean(p.air_passphrase_hash),
      lockedUntil: p.air_passphrase_locked_until && new Date(p.air_passphrase_locked_until).getTime() > Date.now() ? p.air_passphrase_locked_until : null,
      failures: p.air_passphrase_failures ?? 0,
    },
    channels: (channels.data ?? []).map((c) => ({ channel: c.channel, linkedAt: c.created_at })),
    dots: dots.data ?? [],
    jobs: jobs.data ?? [],
  };
}

/** Pause: stop every running job, pause the shared machine and each dot's build machine. Work is kept. */
export async function pauseUserAir(userId: string) {
  const { data: dots } = await supabaseAdmin.from("air_dots").select("conversation_id").eq("user_id", userId);
  const convs = (dots ?? []).map((d) => d.conversation_id as string);
  const { data: running } = await supabaseAdmin.from("air_jobs").select("conversation_id").eq("user_id", userId).eq("status", "running");
  for (const r of running ?? []) await stopAirJob(userId, r.conversation_id as string).catch(() => undefined);
  const machine = await pauseAirMachine(userId).catch(() => false);
  let builds = 0;
  if (convs.length && env.e2bApiKey) {
    const { data: projects } = await supabaseAdmin.from("build_projects").select("sandbox_id").in("conversation_id", convs).not("sandbox_id", "is", null);
    for (const proj of projects ?? []) {
      const sb = await Sandbox.connect(proj.sandbox_id as string, { apiKey: env.e2bApiKey }).catch(() => null);
      if (sb && (await (sb as unknown as { pause: () => Promise<unknown> }).pause().then(() => true).catch(() => false))) builds++;
    }
  }
  const redis = await getRedisClient().catch(() => null);
  if (redis) await redis.del(`air:awake:machine:${userId}`);
  return { stoppedJobs: running?.length ?? 0, pausedComputer: machine, pausedBuilds: builds };
}

export async function unlockPassphrase(userId: string) {
  await supabaseAdmin.from("profiles").update({ air_passphrase_failures: 0, air_passphrase_locked_until: null }).eq("id", userId);
}

export async function clearPassphrase(userId: string) {
  await supabaseAdmin.from("profiles").update({ air_passphrase_hash: null, air_passphrase_failures: 0, air_passphrase_locked_until: null }).eq("id", userId);
}
