import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Badge, Button, Card, ErrorNote, Field, Input, Loading, PageHeader, Stat, Toggle, statusTone, timeAgo } from "../ui";

type AirOverview = {
  stats: { runningJobs: number; waitingOnPeople: number; callsLast24h: number; callMinutesThisMonth: number };
  jobs: { id: string; user: string; task: string; status: string; summary: string | null; rounds: number; source: string; created_at: string }[];
  calls: { id: string; user: string; direction: string; trunk: string | null; status: string; seconds: number; summary: string | null; created_at: string }[];
  refused: { id: number; user: string; kind: string; name: string; detail: string; created_at: string }[];
};

type PhoneConfig = {
  enabledPlanIds: string[];
  inrPerMinute: number;
  includedMinutes: number;
  hardCapMinutes: number;
  maxHeldSeconds: number;
  voice?: "gemini" | "sarvam";
  channels: { telegram: boolean; whatsapp: boolean; email: boolean };
};

export default function Phone() {
  const [config, setConfig] = useState<PhoneConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [air, setAir] = useState<AirOverview | null>(null);
  const [tab, setTab] = useState<"jobs" | "calls" | "refused">("jobs");

  useEffect(() => {
    api
      .get<{ config: PhoneConfig }>("/console/phone")
      .then((res) => setConfig(res.config))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Couldn't load phone settings."));
    void api.get<AirOverview>("/console/phone/air").then(setAir).catch(() => setAir(null));
  }, []);

  async function save() {
    if (!config) return;
    setError(null);
    setSaved(false);
    try {
      const res = await api.put<{ config: PhoneConfig }>("/console/phone", config);
      setConfig(res.config);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save.");
    }
  }

  if (!config) return error ? <ErrorNote error={error} /> : <Loading label="Opening phone settings" />;

  return (
    <div className="grid gap-6">
      <PageHeader title="Phone & Air Dots" description="Who may call and how many minutes come from each plan (Plans & offers → Call minutes / month, Air Dots, Sandbox awake minutes). This page is the call's own settings and what Air Dots is doing right now." />
      <ErrorNote error={error} />
      {air && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Jobs running" value={air.stats.runningJobs} />
            <Stat label="Waiting on people" value={air.stats.waitingOnPeople} hint="a yes or a sign-in" />
            <Stat label="Calls, last 24 h" value={air.stats.callsLast24h} />
            <Stat label="Call minutes this month" value={air.stats.callMinutesThisMonth} />
          </div>
          <Card className="grid gap-3 p-5">
            <div className="flex gap-2">
              {(["jobs", "calls", "refused"] as const).map((t) => (
                <button key={t} type="button" onClick={() => setTab(t)} className={`h-8 rounded-full border px-3 text-sm ${tab === t ? "border-foreground bg-foreground text-background" : "border-border text-muted"}`}>
                  {t === "jobs" ? "Jobs" : t === "calls" ? "Calls" : "Refused by the gate"}
                </button>
              ))}
            </div>
            <div className="max-h-96 overflow-y-auto text-sm">
              {tab === "jobs" && air.jobs.map((j) => (
                <div key={j.id} className="flex items-start justify-between gap-3 border-b border-border py-2">
                  <div className="min-w-0"><p className="truncate">{j.task}</p><p className="truncate text-xs text-muted">{j.user} · {j.source} · {j.rounds} turns{j.summary ? ` · ${j.summary}` : ""}</p></div>
                  <div className="shrink-0 text-right"><Badge tone={statusTone(j.status)}>{j.status.replace("_", " ")}</Badge><p className="mt-1 text-xs text-muted">{timeAgo(j.created_at)}</p></div>
                </div>
              ))}
              {tab === "calls" && air.calls.map((c) => (
                <div key={c.id} className="flex items-start justify-between gap-3 border-b border-border py-2">
                  <div className="min-w-0"><p className="truncate">{c.user} · {c.direction}{c.trunk ? ` via ${c.trunk}` : ""}</p><p className="truncate text-xs text-muted">{c.summary ?? "—"}</p></div>
                  <div className="shrink-0 text-right"><p>{Math.ceil(c.seconds / 60)} min</p><p className="text-xs text-muted">{timeAgo(c.created_at)}</p></div>
                </div>
              ))}
              {tab === "refused" && air.refused.map((r) => (
                <div key={r.id} className="border-b border-border py-2"><p className="truncate">{r.detail}</p><p className="text-xs text-muted">{r.user} · {r.kind} · {r.name} · {timeAgo(r.created_at)}</p></div>
              ))}
            </div>
          </Card>
        </>
      )}
      <Card className="grid gap-4 p-5">
        <Field label="Plans that can call (older clients only)" hint="New code reads each plan's Air Dots + Call minutes entitlements instead.">
          <Input value={config.enabledPlanIds.join(", ")} onChange={(e) => setConfig({ ...config, enabledPlanIds: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="₹ per minute">
            <Input type="number" value={config.inrPerMinute} onChange={(e) => setConfig({ ...config, inrPerMinute: Number(e.target.value) })} />
          </Field>
          <Field label="Max seconds held on the line">
            <Input type="number" value={config.maxHeldSeconds} onChange={(e) => setConfig({ ...config, maxHeldSeconds: Number(e.target.value) })} />
          </Field>
          <Field label="Included minutes">
            <Input type="number" value={config.includedMinutes} onChange={(e) => setConfig({ ...config, includedMinutes: Number(e.target.value) })} />
          </Field>
          <Field label="Hard cap minutes (older clients only)">
            <Input type="number" value={config.hardCapMinutes} onChange={(e) => setConfig({ ...config, hardCapMinutes: Number(e.target.value) })} />
          </Field>
        </div>
        <Field label="Voice" hint="Gemini Live is the call. Sarvam is the Indian voice.">
          <Input value={config.voice ?? "gemini"} onChange={(e) => setConfig({ ...config, voice: e.target.value === "sarvam" ? "sarvam" : "gemini" })} />
        </Field>
        <Toggle checked={config.channels.telegram} onChange={(telegram) => setConfig({ ...config, channels: { ...config.channels, telegram } })} label="Telegram delivery" />
        <Toggle checked={config.channels.whatsapp} onChange={(whatsapp) => setConfig({ ...config, channels: { ...config.channels, whatsapp } })} label="WhatsApp delivery" />
        <Toggle checked={config.channels.email} onChange={(email) => setConfig({ ...config, channels: { ...config.channels, email } })} label="Email delivery" />
        <div className="flex items-center gap-3">
          <Button onClick={() => void save()}>Save</Button>
          {saved && <span className="text-sm text-muted">Saved. Every server picks it up within a minute.</span>}
        </div>
      </Card>
    </div>
  );
}
