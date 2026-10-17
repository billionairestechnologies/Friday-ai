import { lazy, Suspense, useEffect, useMemo, useState, type ComponentType } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  BadgeIndianRupee,
  Boxes,
  ClipboardList,
  Cpu,
  Gauge,
  Handshake,
  Inbox,
  LifeBuoy,
  LogOut,
  Mail,
  Megaphone,
  Menu,
  MessageSquare,
  ScrollText,
  Server,
  Send,
  ShieldCheck,
  Ticket,
  Gift,
  ListChecks,
  GraduationCap,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { BrandWordmark } from "@/components/brand-mark";
import { useAuthStore } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { AdminLoginPage } from "@/routes/admin";
import { cn } from "@/lib/utils";
import { hasPermission, useConsole } from "./access";
import { Avatar, Loading, Toaster } from "./ui";

/**
 * The Team Console (/admin): the company's back office. Every section declares the permission it
 * needs; the nav only shows what the signed-in teammate's role allows (the API enforces the same
 * rules, so hiding is UX, not security). Sections are code-split so the console never weighs on
 * the chat app's bundle.
 */

type Section = {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  permission: string;
  group: "Workspace" | "Growth" | "Admin";
  component: ComponentType;
};

const Overview = lazy(() => import("./sections/Overview"));
const Support = lazy(() => import("./sections/Support"));
const Crm = lazy(() => import("./sections/Crm"));
const Tasks = lazy(() => import("./sections/Tasks"));
const Updates = lazy(() => import("./sections/Updates"));
const Marketing = lazy(() => import("./sections/Marketing"));
const Plans = lazy(() => import("./sections/Plans"));
const UsersSection = lazy(() => import("./sections/Users"));
const Team = lazy(() => import("./sections/Team"));
const MailSection = lazy(() => import("./sections/MailSettings"));
const Models = lazy(() => import("./sections/Models"));
const Billing = lazy(() => import("./sections/Billing"));
const Audit = lazy(() => import("./sections/Audit"));
const StatusSection = lazy(() => import("./sections/Status"));
const Finance = lazy(() => import("./sections/Finance"));
const UsageLedger = lazy(() => import("./sections/UsageLedger"));
const Credits = lazy(() => import("./sections/Credits"));
const Programs = lazy(() => import("./sections/Programs"));
const Jobs = lazy(() => import("./sections/Jobs"));
const Mailbox = lazy(() => import("./sections/Mailbox"));
const MailHosting = lazy(() => import("./sections/MailHosting"));

export const SECTIONS: Section[] = [
  { id: "overview", label: "Overview", icon: Gauge, permission: "overview.view", group: "Workspace", component: Overview },
  { id: "support", label: "Support", icon: LifeBuoy, permission: "support.view", group: "Workspace", component: Support },
  { id: "crm", label: "CRM", icon: Handshake, permission: "crm.view", group: "Workspace", component: Crm },
  { id: "mailbox", label: "Mailbox", icon: Inbox, permission: "mailbox.use", group: "Workspace", component: Mailbox },
  { id: "tasks", label: "Tasks", icon: ClipboardList, permission: "tasks.view", group: "Workspace", component: Tasks },
  { id: "updates", label: "Product updates", icon: Megaphone, permission: "updates.view", group: "Growth", component: Updates },
  { id: "marketing", label: "Email campaigns", icon: Send, permission: "marketing.view", group: "Growth", component: Marketing },
  { id: "plans", label: "Plans & offers", icon: Ticket, permission: "plans.view", group: "Growth", component: Plans },
  { id: "credits", label: "Credits", icon: Gift, permission: "credits.view", group: "Growth", component: Credits },
  { id: "programs", label: "Programmes", icon: GraduationCap, permission: "plans.view", group: "Growth", component: Programs },
  { id: "users", label: "Users", icon: Users, permission: "users.view", group: "Admin", component: UsersSection },
  { id: "team", label: "Team & roles", icon: ShieldCheck, permission: "team.manage", group: "Admin", component: Team },
  { id: "mail-hosting", label: "Mail hosting", icon: Server, permission: "mail.manage", group: "Admin", component: MailHosting },
  { id: "mail", label: "Team mail", icon: Mail, permission: "mail.manage", group: "Admin", component: MailSection },
  { id: "status", label: "Status & crashes", icon: Activity, permission: "status.view", group: "Admin", component: StatusSection },
  { id: "jobs", label: "Jobs", icon: ListChecks, permission: "status.view", group: "Admin", component: Jobs },
  { id: "models", label: "Models & keys", icon: Cpu, permission: "providers.view", group: "Admin", component: Models },
  { id: "finance", label: "Finance", icon: Wallet, permission: "finance.view", group: "Admin", component: Finance },
  { id: "billing", label: "Billing & usage", icon: BadgeIndianRupee, permission: "users.view", group: "Admin", component: Billing },
  { id: "usage", label: "Usage ledger", icon: Gauge, permission: "users.view", group: "Admin", component: UsageLedger },
  { id: "audit", label: "Audit log", icon: ScrollText, permission: "audit.view", group: "Admin", component: Audit },
];

export function ConsoleApp({ section }: { section?: string }) {
  const { user, isPending } = useCurrentUserState();
  const status = useConsole((s) => s.status);
  const load = useConsole((s) => s.load);
  const reset = useConsole((s) => s.reset);

  // Keyed on the id, not the user object: the auth hook hands back a fresh object on re-renders,
  // which re-fired load() in a loop and left the console stuck on "Opening…".
  const userId = user?.id ?? null;
  useEffect(() => {
    if (userId) void load();
    else reset();
  }, [userId, load, reset]);

  if (isPending || (user && (status === "idle" || status === "loading"))) {
    return (
      <div className="grid h-dvh place-items-center bg-background">
        <Loading label="Opening the Team Console" />
      </div>
    );
  }
  if (!user) return <AdminLoginPage />;
  if (status === "denied") return <AdminLoginPage deniedMessage="This account doesn't have Team Console access. Ask an admin to invite you." />;
  if (status === "error") return <AdminLoginPage deniedMessage={useConsole.getState().error ?? "Couldn't open the console"} />;
  return <ConsoleShell section={section} />;
}

function ConsoleShell({ section }: { section?: string }) {
  const navigate = useNavigate();
  const me = useConsole((s) => s.me)!;
  const logout = useAuthStore((s) => s.logout);
  const [navOpen, setNavOpen] = useState(false);
  const allowed = useMemo(() => SECTIONS.filter((s) => hasPermission(me.staff.permissions, s.permission)), [me]);
  const active = allowed.find((s) => s.id === section) ?? allowed[0];

  useEffect(() => {
    if (active && active.id !== section) void navigate({ to: "/admin/$section", params: { section: active.id }, replace: true });
  }, [active, section, navigate]);

  const go = (id: string) => {
    void navigate({ to: "/admin/$section", params: { section: id } });
    setNavOpen(false);
  };

  const nav = (
    <nav className="flex h-full flex-col">
      <div className="flex h-16 items-center gap-2 px-5">
        <BrandWordmark className="text-xl" />
        <span className="rounded-md border border-border px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-subtle uppercase">Console</span>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {(["Workspace", "Growth", "Admin"] as const).map((group) => {
          const items = allowed.filter((s) => s.group === group);
          if (!items.length) return null;
          return (
            <div key={group} className="mt-4 first:mt-1">
              <div className="px-3 pb-1.5 text-[11px] font-semibold tracking-wider text-subtle uppercase">{group}</div>
              {items.map((s) => {
                const Icon = s.icon;
                const on = s.id === active?.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => go(s.id)}
                    className={cn(
                      "premium-control relative flex h-10 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-medium transition-colors duration-150",
                      on ? "text-foreground" : "text-muted hover:bg-chip hover:text-foreground",
                    )}
                  >
                    {on && <motion.span layoutId="console-nav" className="absolute inset-0 rounded-xl bg-chip-on" transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }} />}
                    <Icon className="relative size-4" />
                    <span className="relative">{s.label}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="border-t border-border p-3">
        <div className="flex items-center gap-3 rounded-xl px-2 py-2">
          <Avatar name={me.staff.name || me.staff.email || "?"} size={32} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground">{me.staff.name || me.staff.email}</div>
            <div className="truncate text-xs text-subtle">{me.staff.roleName}{me.staff.title ? ` · ${me.staff.title}` : ""}</div>
          </div>
        </div>
        <div className="mt-1 flex gap-1">
          <a href="/" className="premium-control flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl text-xs font-medium text-muted hover:bg-chip hover:text-foreground">
            <MessageSquare className="size-3.5" /> Open Friday
          </a>
          <button type="button" onClick={() => void logout()} className="premium-control flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl text-xs font-medium text-muted hover:bg-chip hover:text-foreground">
            <LogOut className="size-3.5" /> Log out
          </button>
        </div>
      </div>
    </nav>
  );

  const ActiveComponent = active?.component;
  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      <aside className="hidden w-64 shrink-0 border-r border-border md:block">{nav}</aside>
      <AnimatePresence>
        {navOpen && (
          <>
            <motion.div className="fixed inset-0 z-40 bg-black/50 md:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setNavOpen(false)} />
            <motion.aside className="fixed inset-y-0 left-0 z-50 w-72 border-r border-border bg-background md:hidden" initial={{ x: -288 }} animate={{ x: 0 }} exit={{ x: -288 }} transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}>
              {nav}
            </motion.aside>
          </>
        )}
      </AnimatePresence>
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3 md:hidden">
          <button type="button" onClick={() => setNavOpen((v) => !v)} className="flex size-9 items-center justify-center rounded-full text-muted hover:bg-chip" aria-label="Menu">
            {navOpen ? <X className="size-4" /> : <Menu className="size-4" />}
          </button>
          <span className="text-sm font-semibold">{active?.label}</span>
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-8 md:py-8">
            {ActiveComponent ? (
              <AnimatePresence mode="wait">
                <motion.div key={active.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}>
                  <Suspense fallback={<Loading />}>
                    <ActiveComponent />
                  </Suspense>
                </motion.div>
              </AnimatePresence>
            ) : (
              <div className="py-24 text-center text-sm text-muted">
                <Boxes className="mx-auto mb-3 size-6" />
                Your role doesn't include any console sections yet — ask an admin to update it.
              </div>
            )}
          </div>
        </div>
      </main>
      <Toaster />
    </div>
  );
}
