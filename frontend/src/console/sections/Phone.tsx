import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, Card, ErrorNote, Field, Input, Loading, PageHeader, Toggle } from "../ui";

type PhoneConfig = {
  enabledPlanIds: string[];
  inrPerMinute: number;
  includedMinutes: number;
  hardCapMinutes: number;
  maxHeldSeconds: number;
  channels: { telegram: boolean; whatsapp: boolean; email: boolean };
};

export default function Phone() {
  const [config, setConfig] = useState<PhoneConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api
      .get<{ config: PhoneConfig }>("/console/phone")
      .then((res) => setConfig(res.config))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Couldn't load phone settings."));
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
      <PageHeader title="Phone" description="One config for the call. Premium is the default. Plans, the price, and the channels are edited here." />
      <ErrorNote error={error} />
      <Card className="grid gap-4 p-5">
        <Field label="Plans that can call" hint="Comma separated. premium is the default.">
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
          <Field label="Hard cap minutes">
            <Input type="number" value={config.hardCapMinutes} onChange={(e) => setConfig({ ...config, hardCapMinutes: Number(e.target.value) })} />
          </Field>
        </div>
        <Toggle checked={config.channels.telegram} onChange={(telegram) => setConfig({ ...config, channels: { ...config.channels, telegram } })} label="Telegram delivery" />
        <Toggle checked={config.channels.whatsapp} onChange={(whatsapp) => setConfig({ ...config, channels: { ...config.channels, whatsapp } })} label="WhatsApp delivery" />
        <Toggle checked={config.channels.email} onChange={(email) => setConfig({ ...config, channels: { ...config.channels, email } })} label="Email delivery" />
        <div className="flex items-center gap-3">
          <Button onClick={() => void save()}>Save</Button>
          {saved && <span className="text-sm text-muted">Saved for this server.</span>}
        </div>
      </Card>
    </div>
  );
}
