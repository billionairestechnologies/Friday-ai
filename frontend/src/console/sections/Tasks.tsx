import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { CalendarClock, ClipboardList, Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useCan, useConsole } from "../access";
import { useStaffOptions } from "../useStaff";
import { Avatar, Badge, Button, Drawer, EmptyState, ErrorNote, Field, Input, Loading, PageHeader, Segmented, Select, Textarea, act, fromLocalInput, statusTone, toLocalInput, useResource } from "../ui";

type Task = {
  id: string;
  title: string;
  description: string;
  status: "todo" | "in_progress" | "done";
  priority: "low" | "normal" | "high" | "urgent";
  assignee_id: string | null;
  assignee: { name: string } | null;
  creator: { name: string } | null;
  due_at: string | null;
  related_type: string | null;
  created_at: string;
};

const COLUMNS: { id: Task["status"]; label: string }[] = [
  { id: "todo", label: "To do" },
  { id: "in_progress", label: "In progress" },
  { id: "done", label: "Done" },
];

export default function Tasks() {
  const [scope, setScope] = useState<"me" | "">("me");
  const [editing, setEditing] = useState<Task | "new" | null>(null);
  const list = useResource<{ tasks: Task[] }>(`/console/tasks${scope ? "?assignee=me" : ""}`);
  const canManage = useCan("tasks.manage");

  async function move(task: Task, status: Task["status"]) {
    const prev = list.data;
    if (!prev || task.status === status) return;
    list.setData({ tasks: prev.tasks.map((t) => (t.id === task.id ? { ...t, status } : t)) });
    if (!(await act(() => api.patch(`/console/tasks/${task.id}`, { status })))) list.setData(prev);
  }

  return (
    <>
      <PageHeader
        title="Tasks"
        description="Work the team hands to each other — linked to tickets and deals when it helps."
        actions={canManage && <Button variant="primary" onClick={() => setEditing("new")}><Plus className="size-4" /> New task</Button>}
      />
      <ErrorNote error={list.error} />
      <div className="mb-4">
        <Segmented value={scope} onChange={setScope} options={[{ value: "me", label: "Assigned to me" }, { value: "", label: "Whole team" }]} />
      </div>
      {list.loading && !list.data ? (
        <Loading />
      ) : !list.data?.tasks.length ? (
        <EmptyState icon={ClipboardList} title="Nothing on the board" text="Create a task and assign it to a teammate." action={canManage && <Button variant="primary" onClick={() => setEditing("new")}>New task</Button>} />
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          {COLUMNS.map((col) => {
            const tasks = list.data!.tasks.filter((t) => t.status === col.id);
            return (
              <div
                key={col.id}
                onDragOver={(e) => canManage && e.preventDefault()}
                onDrop={(e) => {
                  const task = list.data!.tasks.find((t) => t.id === e.dataTransfer.getData("text/task"));
                  if (task) void move(task, col.id);
                }}
                className="flex min-h-40 flex-col rounded-[var(--radius-xl)] border border-border bg-surface/60 p-2.5"
              >
                <div className="flex items-center gap-2 px-1.5 pb-2">
                  <span className="text-sm font-semibold">{col.label}</span>
                  <span className="text-xs text-subtle tabular-nums">{tasks.length}</span>
                </div>
                <div className="flex flex-col gap-2">
                  {tasks.map((t) => {
                    const overdue = t.due_at && t.status !== "done" && new Date(t.due_at).getTime() < Date.now();
                    return (
                      <motion.div layout key={t.id} transition={{ duration: 0.2 }}>
                        <button
                          type="button"
                          draggable={canManage}
                          onDragStart={(e) => e.dataTransfer.setData("text/task", t.id)}
                          onClick={() => setEditing(t)}
                          className="w-full cursor-grab rounded-2xl border border-border bg-background p-3 text-left shadow-[var(--shadow-soft)] active:cursor-grabbing"
                        >
                          <div className={cn("text-sm font-medium", t.status === "done" && "text-muted line-through decoration-border")}>{t.title}</div>
                          <div className="mt-2 flex items-center gap-2">
                            {t.priority !== "normal" && <Badge tone={statusTone(t.priority)}>{t.priority}</Badge>}
                            {t.due_at && (
                              <span className={cn("inline-flex items-center gap-1 text-[11px]", overdue ? "text-danger" : "text-subtle")}>
                                <CalendarClock className="size-3" /> {new Date(t.due_at).toLocaleDateString()}
                              </span>
                            )}
                            <span className="ml-auto">{t.assignee && <Avatar name={t.assignee.name} size={22} />}</span>
                          </div>
                        </button>
                      </motion.div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <TaskDrawer task={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void list.reload(); }} />
    </>
  );
}

function TaskDrawer({ task, onClose, onSaved }: { task: Task | "new" | null; onClose: () => void; onSaved: () => void }) {
  const staff = useStaffOptions();
  const me = useConsole((s) => s.me);
  const canManage = useCan("tasks.manage");
  const blank = { title: "", description: "", status: "todo" as Task["status"], priority: "normal" as Task["priority"], assigneeId: me?.staff.userId ?? "", dueAt: "" };
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (task === "new") setForm(blank);
    else if (task) setForm({ title: task.title, description: task.description, status: task.status, priority: task.priority, assigneeId: task.assignee_id ?? "", dueAt: toLocalInput(task.due_at) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task]);
  const existing = task && task !== "new" ? task : null;
  return (
    <Drawer
      open={Boolean(task)}
      onClose={onClose}
      title={existing ? "Task" : "New task"}
      subtitle={existing?.creator ? `Created by ${existing.creator.name}` : undefined}
      footer={
        canManage && (
          <>
            {existing && (
              <Button variant="danger" onClick={async () => { if (await act(() => api.delete(`/console/tasks/${existing.id}`), "Task deleted")) onSaved(); }}>
                <Trash2 className="size-3.5" />
              </Button>
            )}
            <span className="flex-1" />
            <Button
              variant="primary"
              loading={busy}
              disabled={!form.title.trim()}
              onClick={async () => {
                setBusy(true);
                const payload = { ...form, assigneeId: form.assigneeId || null, dueAt: fromLocalInput(form.dueAt) };
                const ok = await act(() => (existing ? api.patch(`/console/tasks/${existing.id}`, payload) : api.post("/console/tasks", payload)), existing ? "Saved" : "Task created");
                setBusy(false);
                if (ok) onSaved();
              }}
            >
              {existing ? "Save" : "Create task"}
            </Button>
          </>
        )
      }
    >
      <div className="grid gap-3">
        <Field label="Title"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} autoFocus /></Field>
        <Field label="Details"><Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Assignee"><Select value={form.assigneeId} onChange={(e) => setForm({ ...form, assigneeId: e.target.value })} options={[{ value: "", label: "Unassigned" }, ...staff.map((s) => ({ value: s.userId, label: s.name }))]} /></Field>
          <Field label="Due"><Input type="datetime-local" value={form.dueAt} onChange={(e) => setForm({ ...form, dueAt: e.target.value })} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Status"><Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Task["status"] })} options={COLUMNS.map((c) => ({ value: c.id, label: c.label }))} /></Field>
          <Field label="Priority"><Select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as Task["priority"] })} options={["low", "normal", "high", "urgent"].map((p) => ({ value: p, label: p[0]!.toUpperCase() + p.slice(1) }))} /></Field>
        </div>
      </div>
    </Drawer>
  );
}
