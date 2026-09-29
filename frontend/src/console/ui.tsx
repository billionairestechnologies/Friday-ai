import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2, X } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { create } from "zustand";

/** Team Console UI kit — one visual language for every section (tokens from styles.css). */

const ease = [0.22, 1, 0.36, 1] as const;

// ── Data ──────────────────────────────────────────────────────────────────────

/** GET a console resource; `reload()` refetches. Keeps the previous data while reloading (no flicker). */
export function useResource<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const seq = useRef(0);
  const reload = useCallback(() => {
    if (!path) return Promise.resolve();
    const mine = ++seq.current;
    setLoading(true);
    return api
      .get<T>(path)
      .then((res) => {
        if (mine !== seq.current) return;
        setData(res);
        setError(null);
      })
      .catch((err) => mine === seq.current && setError(err instanceof Error ? err.message : "Couldn't load"))
      .finally(() => mine === seq.current && setLoading(false));
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

// ── Toasts ────────────────────────────────────────────────────────────────────

type Toast = { id: number; text: string; tone: "ok" | "error" };
const useToasts = create<{ toasts: Toast[]; push: (text: string, tone?: Toast["tone"]) => void; drop: (id: number) => void }>((set) => ({
  toasts: [],
  push: (text, tone = "ok") => {
    const id = Date.now() + Math.random();
    set((s) => ({ toasts: [...s.toasts, { id, text, tone }] }));
    window.setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 3800);
  },
  drop: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = {
  ok: (text: string) => useToasts.getState().push(text, "ok"),
  error: (text: string) => useToasts.getState().push(text, "error"),
};

/** Runs an action with a toast on failure (and optional success text). Returns true on success. */
export async function act(fn: () => Promise<unknown>, success?: string): Promise<boolean> {
  try {
    await fn();
    if (success) toast.ok(success);
    return true;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Something went wrong");
    return false;
  }
}

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const drop = useToasts((s) => s.drop);
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.2, ease }}
            className={cn(
              "pointer-events-auto flex items-start gap-2 rounded-2xl border px-4 py-3 text-sm shadow-[var(--shadow-panel)] backdrop-blur",
              t.tone === "error" ? "border-danger/40 bg-[color-mix(in_oklab,var(--color-danger)_14%,var(--color-elevated))] text-foreground" : "border-border bg-elevated text-foreground",
            )}
          >
            <span className={cn("mt-1 size-1.5 shrink-0 rounded-full", t.tone === "error" ? "bg-danger" : "bg-emerald-400")} />
            <span className="min-w-0 flex-1">{t.text}</span>
            <button type="button" onClick={() => drop(t.id)} className="text-subtle hover:text-foreground" aria-label="Dismiss">
              <X className="size-3.5" />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

// ── Layout ────────────────────────────────────────────────────────────────────

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="font-[var(--font-heading)] text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ children, className, pad = true }: { children: ReactNode; className?: string; pad?: boolean }) {
  return <div className={cn("rounded-[var(--radius-xl)] border border-border bg-surface shadow-[inset_0_1px_0_var(--surface-highlight)]", pad && "p-5", className)}>{children}</div>;
}

export function Stat({ label, value, hint, accent }: { label: string; value: ReactNode; hint?: ReactNode; accent?: string }) {
  return (
    <Card className="relative overflow-hidden">
      {accent && <span className="absolute inset-x-0 top-0 h-px" style={{ background: `linear-gradient(90deg, transparent, ${accent}, transparent)` }} />}
      <div className="text-xs font-medium tracking-wide text-subtle uppercase">{label}</div>
      <div className="mt-2 font-[var(--font-heading)] text-3xl font-semibold tracking-tight text-foreground tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </Card>
  );
}

const TONES: Record<string, string> = {
  neutral: "bg-chip text-muted",
  blue: "bg-[#4f8cff]/15 text-[#8fb4ff]",
  green: "bg-emerald-500/15 text-emerald-300",
  amber: "bg-amber-500/15 text-amber-300",
  red: "bg-red-500/15 text-red-300",
  purple: "bg-purple-500/15 text-purple-300",
};

export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: keyof typeof TONES | string; className?: string }) {
  return <span className={cn("inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-[11px] font-semibold whitespace-nowrap", TONES[tone] ?? TONES.neutral, className)}>{children}</span>;
}

export function statusTone(status: string): string {
  return (
    {
      published: "green", sent: "green", resolved: "green", done: "green", active: "green", applied: "green", won: "green", client: "green",
      draft: "neutral", closed: "neutral", archived: "neutral", todo: "neutral", expired: "neutral", lead: "blue",
      scheduled: "blue", pending: "amber", in_progress: "blue", open: "blue", sending: "purple",
      failed: "red", rejected: "red", revoked: "red", lost: "red", urgent: "red", high: "amber",
    }[status] ?? "neutral"
  );
}

export function EmptyState({ icon: Icon, title, text, action }: { icon: typeof X; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[var(--radius-xl)] border border-dashed border-border px-6 py-14 text-center">
      <span className="mb-3 flex size-11 items-center justify-center rounded-2xl bg-chip">
        <Icon className="size-5 text-muted" />
      </span>
      <div className="text-sm font-semibold text-foreground">{title}</div>
      {text && <p className="mt-1 max-w-sm text-sm text-muted">{text}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
      <Loader2 className="size-4 animate-spin" /> {label}…
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="mb-4 rounded-2xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div>;
}

// ── Controls ──────────────────────────────────────────────────────────────────

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md"; loading?: boolean };

export function Button({ variant = "secondary", size = "md", loading, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      className={cn(
        "premium-control inline-flex items-center justify-center gap-1.5 rounded-full font-medium whitespace-nowrap transition-[background-color,opacity,transform] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50",
        size === "sm" ? "h-8 px-3 text-xs" : "h-9 px-4 text-sm",
        variant === "primary" && "bg-foreground text-background hover:opacity-90",
        variant === "secondary" && "border border-border bg-elevated text-foreground hover:bg-chip-on",
        variant === "ghost" && "text-muted hover:bg-chip hover:text-foreground",
        variant === "danger" && "border border-danger/40 text-danger hover:bg-danger/10",
        className,
      )}
    >
      {loading && <Loader2 className="size-3.5 animate-spin" />}
      {children}
    </button>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn("flex flex-col gap-1.5", className)}>
      <span className="text-xs font-semibold text-muted">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-subtle">{hint}</span>}
    </label>
  );
}

const control =
  "w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-subtle focus:border-[color-mix(in_oklab,var(--color-primary)_60%,var(--color-border))] focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-primary)_18%,transparent)]";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(control, "h-10", props.className)} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn(control, "min-h-[96px] resize-y py-2.5 leading-relaxed", props.className)} />;
}

export function Select({ options, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { options: { value: string; label: string }[] }) {
  return (
    <select {...props} className={cn(control, "h-10 cursor-pointer pr-8", props.className)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="inline-flex items-center gap-2 text-sm text-foreground">
      <span className={cn("relative h-5 w-9 rounded-full transition-colors duration-200", checked ? "bg-foreground" : "bg-chip-on")}>
        <span className={cn("absolute top-0.5 size-4 rounded-full bg-background shadow transition-transform duration-200", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
      </span>
      {label}
    </button>
  );
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; count?: number }[] }) {
  return (
    <div className="inline-flex rounded-full bg-chip p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors duration-150",
            value === o.value ? "bg-background text-foreground shadow-sm" : "text-muted hover:text-foreground",
          )}
        >
          {o.label}
          {o.count != null && <span className="text-[10px] text-subtle tabular-nums">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ── Overlays ──────────────────────────────────────────────────────────────────

/** Right-side slide-over for detail/edit views. */
export function Drawer({ open, onClose, title, subtitle, children, footer, width = 560 }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div key="scrim" className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} onClick={onClose} />
          <motion.aside
            key="drawer"
            className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-background shadow-[var(--shadow-panel)]"
            style={{ maxWidth: width }}
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ duration: 0.26, ease }}
          >
            <div className="flex items-start gap-3 border-b border-border px-6 py-4">
              <div className="min-w-0 flex-1">
                <div className="truncate text-base font-semibold text-foreground">{title}</div>
                {subtitle && <div className="mt-0.5 text-xs text-muted">{subtitle}</div>}
              </div>
              <button type="button" onClick={onClose} aria-label="Close" className="flex size-8 items-center justify-center rounded-full text-muted hover:bg-chip hover:text-foreground">
                <X className="size-4" />
              </button>
            </div>
            <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
            {footer && <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-3">{footer}</div>}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

export function Modal({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <motion.div
            className="w-full max-w-lg overflow-hidden rounded-[var(--radius-2xl)] border border-border bg-background shadow-[var(--shadow-panel)]"
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.22, ease }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-border px-6 py-4 text-base font-semibold">{title}</div>
            <div className="px-6 py-5">{children}</div>
            {footer && <div className="flex justify-end gap-2 border-t border-border px-6 py-3">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ── Formatting ────────────────────────────────────────────────────────────────

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
}

export function formatNumber(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString();
}

export function formatMoney(amount: number, currency = "INR"): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString()}`;
  }
}

/** datetime-local input value ↔ ISO string. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export function fromLocalInput(value: string): string | null {
  return value ? new Date(value).toISOString() : null;
}

export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  const initials = name.split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
      style={{ width: size, height: size, background: `linear-gradient(135deg, hsl(${hue} 55% 45%), hsl(${(hue + 40) % 360} 60% 35%))` }}
      aria-hidden
    >
      {initials}
    </span>
  );
}
