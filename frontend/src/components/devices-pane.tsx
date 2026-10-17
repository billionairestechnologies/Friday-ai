import { useEffect, useState } from "react";
import { Laptop, Smartphone, Terminal } from "lucide-react";
import { api } from "@/lib/api";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

/**
 * Settings → Devices (backend services/sessions, supabase 0068): every place this account is signed
 * in — browsers, the Android/iPhone apps and FridayX in terminals/editors — with "Sign out" per
 * device and "Sign out everywhere else". A signed-out device is refused on its very next request.
 */

export type DeviceSession = {
  id: string;
  kind: "app" | "cli";
  platform: "web" | "android" | "ios" | "other" | "cli";
  client: string;
  ipPrefix: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  current: boolean;
};

export function lastActive(iso: string | null): string {
  if (!iso) return "Not used yet";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 2) return "Active now";
  if (mins < 60) return `Active ${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `Active ${hours} h ago`;
  return `Active ${new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

export function DeviceIcon({ platform }: { platform: DeviceSession["platform"] }) {
  const Icon = platform === "cli" ? Terminal : platform === "android" || platform === "ios" ? Smartphone : Laptop;
  return <Icon className="size-4 text-muted" aria-hidden />;
}

export function DevicesPane() {
  const { user } = useCurrentUserState();
  const signedIn = Boolean(user && !user.isDevFallback);
  const [sessions, setSessions] = useState<DeviceSession[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () =>
    api
      .get<{ sessions: DeviceSession[] }>("/sessions")
      .then((r) => setSessions(r.sessions))
      .catch((err) => setNotice(err instanceof Error ? err.message : "Couldn't load your devices"));

  useEffect(() => {
    if (signedIn) void load();
  }, [signedIn]);

  async function signOutOne(s: DeviceSession) {
    setBusy(s.id);
    setNotice(null);
    try {
      await api.delete(`/sessions/${s.id}?kind=${s.kind}`);
      setSessions((prev) => (prev ?? []).filter((x) => x.id !== s.id));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Couldn't sign that device out");
    } finally {
      setBusy(null);
    }
  }

  async function signOutOthers() {
    if (!window.confirm("Sign out of Friday on every other device, including FridayX in terminals and editors?")) return;
    setBusy("others");
    setNotice(null);
    try {
      const r = await api.post<{ signedOut: number }>("/sessions/revoke-others");
      setNotice(r.signedOut ? `Signed out ${r.signedOut} other device${r.signedOut === 1 ? "" : "s"}.` : "No other devices were signed in.");
      await load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Couldn't sign the other devices out");
    } finally {
      setBusy(null);
    }
  }

  const others = (sessions ?? []).filter((s) => !s.current);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Devices</h2>
        <p className="mt-1 text-sm text-muted">Where your account is signed in. If you don't recognise one, sign it out — it stops working straight away.</p>
      </div>
      {!signedIn ? (
        <p className="text-sm text-muted">Sign in to see your devices.</p>
      ) : sessions === null ? (
        <p className="text-sm text-muted">{notice ?? "Loading…"}</p>
      ) : (
        <>
          <ul className="divide-y divide-border rounded-xl border border-border">
            {sessions.length === 0 && <li className="px-3 py-3 text-sm text-muted">No devices to show yet.</li>}
            {sessions.map((s) => (
              <li key={`${s.kind}-${s.id}`} className="flex items-center gap-3 px-3 py-2.5">
                <DeviceIcon platform={s.platform} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {s.client}
                    {s.current && <span className="ml-2 rounded-full bg-chip px-2 py-0.5 text-[11px] font-medium text-muted">This device</span>}
                  </p>
                  <p className="text-xs text-muted">
                    {s.current ? "Active now" : lastActive(s.lastSeenAt)}
                    {s.ipPrefix ? ` · ${s.ipPrefix}` : ""}
                    {` · signed in ${new Date(s.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`}
                  </p>
                </div>
                {!s.current && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void signOutOne(s)}
                    className="h-8 shrink-0 rounded-full border border-border px-3 text-xs font-medium hover:bg-chip disabled:opacity-60"
                  >
                    {busy === s.id ? "Signing out…" : "Sign out"}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {others.length > 0 && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void signOutOthers()}
              className="h-9 self-start rounded-full border border-border px-4 text-sm font-medium text-danger hover:bg-chip disabled:opacity-60"
            >
              {busy === "others" ? "Signing out…" : "Sign out everywhere else"}
            </button>
          )}
          {notice && <p className="text-xs text-muted" role="status">{notice}</p>}
        </>
      )}
    </div>
  );
}
