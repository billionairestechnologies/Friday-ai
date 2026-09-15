import { useState, type ReactNode } from "react";
import { Check, ChevronDown, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type SearchHit = {
  title: string;
  url: string;
  snippet?: string;
};

export function ThoughtTrail({
  live,
  label,
  children,
  defaultOpen,
}: {
  live: boolean;
  label: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? live);
  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-foreground"
      >
        {live ? (
          <Loader2 className="size-3.5 animate-spin text-sky-400" />
        ) : (
          <Check className="size-3.5 text-emerald-400" />
        )}
        <span className={live ? "live-label font-medium" : ""}>{label}</span>
        <ChevronDown
          className={cn(
            "size-3.5 transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </button>
      <div
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-300 ease-in-out",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="overflow-hidden">
          <div className="mt-2 flex flex-col gap-2.5 border-l border-border/70 pl-3.5 ml-1.5">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ThoughtStep({
  title,
  detail,
  status = "complete",
  icon,
  children,
}: {
  title: string;
  detail?: ReactNode;
  status?: "complete" | "active" | "pending" | "error";
  /** Optional leading icon (e.g. a provider logo) shown before the spinner/check/x. */
  icon?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={cn(status === "pending" && "opacity-50")}>
      <p
        className={cn(
          "flex items-center gap-1.5 text-sm",
          status === "active" ? "font-medium text-foreground" : status === "error" ? "text-danger" : "text-muted",
        )}
      >
        {icon}
        {status === "active" && <Loader2 className="size-3 shrink-0 animate-spin text-sky-400" />}
        {status === "error" && <X className="size-3 shrink-0 text-danger" />}
        {title}
      </p>
      {detail && <p className="mt-0.5 text-xs leading-relaxed text-subtle">{detail}</p>}
      {children}
    </div>
  );
}

export function ThoughtSources({ results }: { results: SearchHit[] }) {
  if (results.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {results.map((r) => (
        <a
          key={r.url}
          href={r.url}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-muted underline decoration-border underline-offset-2 transition-colors hover:text-foreground"
        >
          {r.title}
        </a>
      ))}
    </div>
  );
}
