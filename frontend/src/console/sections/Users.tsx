import { useEffect, useState } from "react";
import { Ban, MessageSquare, Search, ShieldCheck, Users as UsersIcon } from "lucide-react";
import { api } from "@/lib/api";
import { useCan } from "../access";
import { Avatar, Badge, Button, Card, Drawer, EmptyState, ErrorNote, Loading, PageHeader, Select, Stat, act, formatDate, formatNumber, statusTone, timeAgo, useResource } from "../ui";

type Row = { id: string; email: string | null; full_name: string | null; plan: string; role: string; created_at: string; last_sign_in_at: string | null; marketing_opt_out: boolean; banned_until: string | null };
type Detail = {
  id: string;
  email: string | null;
  name: string | null;
  phone: string | null;
  plan: string;
  planRenewsAt: string | null;
  customMonthlyCap: number | null;
  role: string;
  marketingOptOut: boolean;
  createdAt: string;
  lastSignInAt: string | null;
  bannedUntil: string | null;
  conversations: number;
  usage30d: Record<string, number>;
  tickets: { id: string; number: number; subject: string; status: string; created_at: string }[];
  crmContact: { id: string; name: string; stage_id: string; kind: string } | null;
};

const PAGE = 50;

export default function Users() {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    const t = window.setTimeout(() => {
      setQuery(q);
      setPage(0);
    }, 300);
    return () => window.clearTimeout(t);
  }, [q]);
  const list = useResource<{ users: Row[] }>(`/console/users?limit=${PAGE}&offset=${page * PAGE}${query ? `&q=${encodeURIComponent(query)}` : ""}`);
  return (
    <>
      <PageHeader title="Users" description="Look anyone up — plan, usage, tickets, deals — and change their plan or access." />
      <ErrorNote error={list.error} />
      <label className="mb-4 flex h-10 max-w-md items-center gap-2 rounded-full border border-border bg-background px-4 text-muted">
        <Search className="size-4" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or email" className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-subtle" />
      </label>
      {list.loading && !list.data ? (
        <Loading />
      ) : !list.data?.users.length ? (
        <EmptyState icon={UsersIcon} title="No users found" />
      ) : (
        <>
          <Card pad={false} className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="border-b border-border text-left text-xs text-subtle">
                <tr>
                  <th className="px-4 py-3 font-medium">User</th>
                  <th className="px-4 py-3 font-medium">Plan</th>
                  <th className="px-4 py-3 font-medium">Joined</th>
                  <th className="px-4 py-3 font-medium">Last seen</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {list.data.users.map((u) => (
                  <tr key={u.id} onClick={() => setOpenId(u.id)} className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-chip/40">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <Avatar name={u.full_name || u.email || "?"} />
                        <div className="min-w-0">
                          <div className="truncate font-medium">{u.full_name || "—"} {u.role === "admin" && <ShieldCheck className="inline size-3.5 text-muted" />}</div>
                          <div className="truncate text-xs text-muted">{u.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2.5"><Badge tone={u.plan === "free" ? "neutral" : "blue"}>{u.plan}</Badge></td>
                    <td className="px-4 py-2.5 text-muted">{formatDate(u.created_at)}</td>
                    <td className="px-4 py-2.5 text-muted">{timeAgo(u.last_sign_in_at)}</td>
                    <td className="px-4 py-2.5">{u.banned_until && new Date(u.banned_until).getTime() > Date.now() ? <Badge tone="red">suspended</Badge> : <Badge tone="green">active</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <div className="mt-3 flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <span className="text-xs text-muted">Page {page + 1}</span>
            <Button size="sm" variant="ghost" disabled={(list.data?.users.length ?? 0) < PAGE} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </>
      )}
      <UserDrawer id={openId} onClose={() => setOpenId(null)} onChanged={() => void list.reload()} />
    </>
  );
}

function UserDrawer({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const { data, setData } = useResource<{ user: Detail }>(id ? `/console/users/${id}` : null);
  const canManage = useCan("users.manage");
  const user = id && data?.user.id === id ? data.user : null;
  const suspended = Boolean(user?.bannedUntil && new Date(user.bannedUntil).getTime() > Date.now());
  const update = async (body: Record<string, unknown>, success: string) => {
    await act(async () => {
      const res = await api.patch<{ user: Detail }>(`/console/users/${id}`, body);
      setData({ user: res.user });
      onChanged();
    }, success);
  };
  return (
    <Drawer open={Boolean(id)} onClose={onClose} width={620} title={user ? user.name || user.email : "Loading…"} subtitle={user?.email}>
      {!user ? (
        <Loading />
      ) : (
        <div className="grid gap-5">
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Plan" value={<span className="text-2xl capitalize">{user.plan}</span>} hint={user.planRenewsAt ? `until ${new Date(user.planRenewsAt).toLocaleDateString()}` : undefined} />
            <Stat label="Chats" value={formatNumber(user.conversations)} />
            <Stat label="Messages 30d" value={formatNumber(user.usage30d.chat_message ?? 0)} />
          </div>
          <Card>
            <div className="grid grid-cols-2 gap-y-2 text-sm">
              <span className="text-muted">Joined</span><span>{formatDate(user.createdAt)}</span>
              <span className="text-muted">Last sign-in</span><span>{formatDate(user.lastSignInAt)}</span>
              <span className="text-muted">Phone</span><span>{user.phone ?? "—"}</span>
              <span className="text-muted">Monthly cap</span><span>{user.customMonthlyCap ? formatNumber(user.customMonthlyCap) : "Plan default"}</span>
              <span className="text-muted">Marketing email</span><span>{user.marketingOptOut ? "Unsubscribed" : "Subscribed"}</span>
              {user.crmContact && (<><span className="text-muted">CRM</span><span><Badge tone={statusTone(user.crmContact.kind)}>{user.crmContact.kind}</Badge> {user.crmContact.stage_id}</span></>)}
            </div>
          </Card>
          <AirCard userId={user.id} canManage={canManage} />
          {canManage && (
            <Card>
              <div className="mb-3 text-sm font-semibold">Manage</div>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={user.plan} onChange={(e) => void update({ plan: e.target.value }, `Plan changed to ${e.target.value}`)} options={[{ value: "free", label: "Free" }, { value: "pro", label: "Pro" }, { value: "premium", label: "Premium" }]} className="w-40" />
                <Button variant={suspended ? "secondary" : "danger"} onClick={() => void update({ suspended: !suspended }, suspended ? "Access restored" : "Account suspended")}>
                  <Ban className="size-3.5" /> {suspended ? "Restore access" : "Suspend"}
                </Button>
              </div>
              <p className="mt-2 text-xs text-subtle">For time-limited access, packages or offers use Plans & offers → Grant access.</p>
            </Card>
          )}
          <div>
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><MessageSquare className="size-4 text-muted" /> Support tickets</div>
            {user.tickets.length === 0 ? (
              <p className="text-sm text-muted">No tickets.</p>
            ) : (
              <ul className="space-y-1.5">
                {user.tickets.map((t) => (
                  <li key={t.id} className="flex items-center gap-2 text-sm">
                    <span className="text-xs text-subtle">#{t.number}</span>
                    <span className="min-w-0 flex-1 truncate">{t.subject}</span>
                    <Badge tone={statusTone(t.status)}>{t.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="mb-2 text-sm font-semibold">Usage · last 30 days</div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(user.usage30d).length === 0 ? <span className="text-sm text-muted">No activity.</span> : Object.entries(user.usage30d).map(([k, v]) => <Badge key={k}>{k.replace(/_/g, " ")}: {formatNumber(v)}</Badge>)}
            </div>
          </div>
        </div>
      )}
    </Drawer>
  );
}

type AirStatus = {
  enabled: boolean;
  computer: { sandboxId: string | null; awake: boolean; awakeUntil: string | null };
  awake: { usedMinutes: number; capMinutes: number };
  calls: { usedMinutes: number; limitMinutes: number; phone: string | null };
  passphrase: { set: boolean; lockedUntil: string | null; failures: number };
  channels: { channel: string; linkedAt: string }[];
  dots: { id: string; name: string }[];
  jobs: { id: string; task: string; status: string; rounds: number; created_at: string }[];
};

/** A person's Air Dots: their computer, minutes, passphrase and channels, with pause / unlock. */
function AirCard({ userId, canManage }: { userId: string; canManage: boolean }) {
  const { data, setData } = useResource<AirStatus>(`/console/users/${userId}/air`);
  if (!data) return null;
  const reload = async () => setData(await api.get<AirStatus>(`/console/users/${userId}/air`));
  const running = data.jobs.filter((j) => j.status === "running").length;
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-semibold">Air Dots</div>
        <Badge tone={data.enabled ? "green" : "neutral"}>{data.enabled ? "On this plan" : "Not on this plan"}</Badge>
      </div>
      <div className="grid grid-cols-2 gap-y-2 text-sm">
        <span className="text-muted">Computer</span>
        <span>{!data.computer.sandboxId ? "None yet" : data.computer.awake ? `Awake until ${new Date(data.computer.awakeUntil!).toLocaleTimeString()}` : "Paused"}</span>
        <span className="text-muted">Awake today</span><span>{data.awake.usedMinutes} / {data.awake.capMinutes} min</span>
        <span className="text-muted">Call minutes</span><span>{data.calls.usedMinutes} / {data.calls.limitMinutes} this month</span>
        <span className="text-muted">Passphrase</span>
        <span>{!data.passphrase.set ? "Not set" : data.passphrase.lockedUntil ? `Locked until ${new Date(data.passphrase.lockedUntil).toLocaleTimeString()}` : `Set${data.passphrase.failures ? ` · ${data.passphrase.failures} wrong tries` : ""}`}</span>
        <span className="text-muted">Channels</span><span>{data.channels.length ? data.channels.map((c) => c.channel).join(", ") : "None linked"}</span>
        <span className="text-muted">Dots</span><span>{data.dots.length ? data.dots.map((d) => d.name).join(", ") : "—"}</span>
        <span className="text-muted">Jobs</span><span>{running ? `${running} running` : "None running"}{data.jobs[0] ? ` · last: ${data.jobs[0].status.replace("_", " ")}` : ""}</span>
      </div>
      {canManage && (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void act(async () => { await api.post(`/console/users/${userId}/air/pause`, {}); await reload(); }, "Paused — jobs stopped, work kept")}>Pause computer</Button>
          {data.passphrase.lockedUntil && <Button size="sm" onClick={() => void act(async () => { await api.post(`/console/users/${userId}/air/unlock`, {}); await reload(); }, "Unlocked")}>Unlock passphrase</Button>}
          {data.passphrase.set && <Button size="sm" variant="ghost" onClick={() => void act(async () => { await api.post(`/console/users/${userId}/air/clear-passphrase`, {}); await reload(); }, "Passphrase cleared — they can set a new one")}>Clear passphrase</Button>}
        </div>
      )}
    </Card>
  );
}
