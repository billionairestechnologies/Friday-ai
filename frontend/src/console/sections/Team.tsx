import { useEffect, useMemo, useState } from "react";
import { KeyRound, Plus, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useConsole, type PermissionInfo } from "../access";
import { Avatar, Badge, Button, Card, Drawer, ErrorNote, Field, Input, Loading, Modal, PageHeader, Segmented, Select, Toggle, act, timeAgo, useResource } from "../ui";

type Member = { userId: string; email: string | null; name: string | null; roleId: string; title: string; team: string; active: boolean; createdAt: string; lastSignInAt: string | null };
type Role = { id: string; name: string; description: string; permissions: string[]; is_system: boolean };
type TeamData = { members: Member[]; roles: Role[]; permissionCatalog: PermissionInfo[] };

export default function Team() {
  const data = useResource<TeamData>("/console/team");
  const [tab, setTab] = useState<"people" | "roles">("people");
  const [inviting, setInviting] = useState(false);
  const [role, setRole] = useState<Role | "new" | null>(null);
  const me = useConsole((s) => s.me);
  const roleName = (id: string) => data.data?.roles.find((r) => r.id === id)?.name ?? (id === "owner" ? "Owner" : id);

  return (
    <>
      <PageHeader
        title="Team & roles"
        description="Give your team their own logins with exactly the access they need — support, marketing, sales, operations, developers."
        actions={
          tab === "people" ? (
            <Button variant="primary" onClick={() => setInviting(true)}><UserPlus className="size-4" /> Add teammate</Button>
          ) : (
            <Button variant="primary" onClick={() => setRole("new")}><Plus className="size-4" /> New role</Button>
          )
        }
      />
      <ErrorNote error={data.error} />
      <div className="mb-4">
        <Segmented value={tab} onChange={setTab} options={[{ value: "people", label: "People", count: data.data?.members.length }, { value: "roles", label: "Roles", count: data.data?.roles.length }]} />
      </div>
      {data.loading && !data.data ? (
        <Loading />
      ) : !data.data ? null : tab === "people" ? (
        <Card pad={false} className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b border-border text-left text-xs text-subtle">
              <tr>
                <th className="px-4 py-3 font-medium">Person</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Team</th>
                <th className="px-4 py-3 font-medium">Last sign-in</th>
                <th className="px-4 py-3 font-medium">Access</th>
              </tr>
            </thead>
            <tbody>
              {data.data.members.map((m) => (
                <MemberRow key={m.userId} m={m} roles={data.data!.roles} self={m.userId === me?.staff.userId} roleName={roleName(m.roleId)} onChanged={() => void data.reload()} />
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.data.roles.map((r) => (
            <button key={r.id} type="button" onClick={() => r.id !== "owner" && setRole(r)} className={cn("text-left", r.id === "owner" && "cursor-default")}>
              <Card className="h-full transition-colors hover:bg-chip/30">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="size-4 text-muted" />
                  <span className="font-semibold">{r.name}</span>
                  {r.is_system && <Badge>built-in</Badge>}
                  <span className="ml-auto text-xs text-subtle">{data.data!.members.filter((m) => m.roleId === r.id).length} people</span>
                </div>
                <p className="mt-2 text-sm text-muted">{r.description || "—"}</p>
                <div className="mt-3 flex flex-wrap gap-1">
                  {r.permissions.includes("*") ? <Badge tone="purple">Everything</Badge> : r.permissions.slice(0, 6).map((p) => <Badge key={p}>{p}</Badge>)}
                  {!r.permissions.includes("*") && r.permissions.length > 6 && <Badge>+{r.permissions.length - 6}</Badge>}
                </div>
              </Card>
            </button>
          ))}
        </div>
      )}
      <InviteModal open={inviting} roles={data.data?.roles ?? []} onClose={() => setInviting(false)} onDone={() => { setInviting(false); void data.reload(); }} />
      <RoleEditor role={role} catalog={data.data?.permissionCatalog ?? []} onClose={() => setRole(null)} onSaved={() => { setRole(null); void data.reload(); }} />
    </>
  );
}

function MemberRow({ m, roles, self, roleName, onChanged }: { m: Member; roles: Role[]; self: boolean; roleName: string; onChanged: () => void }) {
  const ownerAccount = m.roleId === "owner" && !roles.some((r) => r.id === "owner" && m.title !== "Account owner");
  const patch = async (body: Record<string, unknown>, text: string) => {
    if (await act(() => api.patch(`/console/team/${m.userId}`, body), text)) onChanged();
  };
  return (
    <tr className="border-b border-border/60 last:border-0">
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <Avatar name={m.name || m.email || "?"} />
          <div className="min-w-0">
            <div className="truncate font-medium">{m.name || "—"}{self && <span className="text-xs text-subtle"> (you)</span>}</div>
            <div className="truncate text-xs text-muted">{m.email}{m.title ? ` · ${m.title}` : ""}</div>
          </div>
        </div>
      </td>
      <td className="px-4 py-2.5">
        {ownerAccount || self ? (
          <Badge tone="purple">{roleName}</Badge>
        ) : (
          <Select value={m.roleId} onChange={(e) => void patch({ roleId: e.target.value }, "Role updated")} options={roles.map((r) => ({ value: r.id, label: r.name }))} className="h-9 w-40" />
        )}
      </td>
      <td className="px-4 py-2.5 text-muted">{m.team || "—"}</td>
      <td className="px-4 py-2.5 text-muted">{timeAgo(m.lastSignInAt)}</td>
      <td className="px-4 py-2.5">
        {ownerAccount || self ? (
          <Badge tone="green">active</Badge>
        ) : (
          <div className="flex items-center gap-2">
            <Toggle checked={m.active} onChange={(v) => void patch({ active: v }, v ? "Access restored" : "Access paused")} />
            <button
              type="button"
              aria-label="Remove from team"
              onClick={async () => {
                if (window.confirm(`Remove ${m.name || m.email} from the team? Their Friday account stays.`) && (await act(() => api.delete(`/console/team/${m.userId}`), "Removed from team"))) onChanged();
              }}
              className="flex size-8 items-center justify-center rounded-lg text-subtle hover:bg-chip hover:text-danger"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

function InviteModal({ open, roles, onClose, onDone }: { open: boolean; roles: Role[]; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ email: "", name: "", roleId: "support", title: "", team: "" });
  const [busy, setBusy] = useState(false);
  const [temp, setTemp] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setForm({ email: "", name: "", roleId: roles.find((r) => r.id === "support")?.id ?? roles[0]?.id ?? "", title: "", team: "" });
      setTemp(null);
    }
  }, [open, roles]);
  return (
    <Modal
      open={open}
      onClose={temp ? onDone : onClose}
      title={temp ? "Teammate added" : "Add a teammate"}
      footer={
        temp ? (
          <Button variant="primary" onClick={onDone}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!form.email || !form.name}
              onClick={async () => {
                setBusy(true);
                await act(async () => {
                  const res = await api.post<{ emailed: boolean; temporaryPassword?: string }>("/console/team", form);
                  if (res.temporaryPassword) setTemp(res.temporaryPassword);
                  else onDone();
                }, "Invite sent");
                setBusy(false);
              }}
            >
              Add & send invite
            </Button>
          </>
        )
      }
    >
      {temp ? (
        <div className="grid gap-3 text-sm">
          <p className="text-muted">Email isn't configured, so share these sign-in details with {form.name} yourself. They sign in at <span className="font-mono text-foreground">/admin</span>.</p>
          <div className="flex items-center gap-2 rounded-xl bg-chip px-3 py-2 font-mono"><KeyRound className="size-4 text-muted" /> {form.email} · {temp}</div>
        </div>
      ) : (
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Full name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Work email"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@yourcompany.com" /></Field>
          </div>
          <Field label="Role"><Select value={form.roleId} onChange={(e) => setForm({ ...form, roleId: e.target.value })} options={roles.map((r) => ({ value: r.id, label: `${r.name} — ${r.description}` }))} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Title" hint="Optional"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Support lead" /></Field>
            <Field label="Team" hint="Optional"><Input value={form.team} onChange={(e) => setForm({ ...form, team: e.target.value })} placeholder="Customer success" /></Field>
          </div>
          <p className="text-xs text-subtle">New people get an account and an email with a temporary password. Existing Friday users keep their password.</p>
        </div>
      )}
    </Modal>
  );
}

function RoleEditor({ role, catalog, onClose, onSaved }: { role: Role | "new" | null; catalog: PermissionInfo[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: "", description: "", permissions: [] as string[] });
  const [busy, setBusy] = useState(false);
  const existing = role && role !== "new" ? role : null;
  useEffect(() => {
    if (role === "new") setForm({ name: "", description: "", permissions: ["overview.view"] });
    else if (role) setForm({ name: role.name, description: role.description, permissions: role.permissions });
  }, [role]);
  const groups = useMemo(() => {
    const out = new Map<string, PermissionInfo[]>();
    for (const p of catalog) out.set(p.group, [...(out.get(p.group) ?? []), p]);
    return [...out.entries()];
  }, [catalog]);
  const everything = form.permissions.includes("*");
  const toggle = (id: string, on: boolean) => setForm({ ...form, permissions: on ? [...new Set([...form.permissions, id])] : form.permissions.filter((p) => p !== id) });
  return (
    <Drawer
      open={Boolean(role)}
      onClose={onClose}
      title={existing ? `Edit ${existing.name}` : "New role"}
      footer={
        <>
          {existing && !existing.is_system && (
            <Button variant="danger" onClick={async () => { if (window.confirm("Delete this role?") && (await act(() => api.delete(`/console/roles/${existing.id}`), "Role deleted"))) onSaved(); }}>
              <Trash2 className="size-3.5" />
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="primary" loading={busy} disabled={!form.name.trim()} onClick={async () => { setBusy(true); const ok = await act(() => api.post("/console/roles", { ...(existing ? { id: existing.id } : {}), ...form }), "Role saved"); setBusy(false); if (ok) onSaved(); }}>
            Save role
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Role name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Customer success" /></Field>
        <Field label="Description"><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        <Toggle checked={everything} onChange={(v) => setForm({ ...form, permissions: v ? ["*"] : ["overview.view"] })} label="Full access to everything (admin)" />
        {!everything && (
          <div className="grid gap-3">
            {groups.map(([group, perms]) => (
              <Card key={group} className="py-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-sm font-semibold">{group}</span>
                  <button type="button" className="ml-auto text-xs text-muted hover:text-foreground" onClick={() => setForm({ ...form, permissions: [...new Set([...form.permissions, ...perms.map((p) => p.id)])] })}>
                    Select all
                  </button>
                </div>
                <div className="grid gap-1.5">
                  {perms.map((p) => (
                    <label key={p.id} className="flex items-start gap-2.5 text-sm">
                      <input type="checkbox" className="mt-1" checked={form.permissions.includes(p.id) || form.permissions.includes(`${p.id.split(".")[0]}.*`)} onChange={(e) => toggle(p.id, e.target.checked)} />
                      <span>
                        {p.label}
                        <span className="ml-1.5 font-mono text-[11px] text-subtle">{p.id}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </Drawer>
  );
}
