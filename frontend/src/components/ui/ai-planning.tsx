import { useEffect, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Check,
  BrainCircuit,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type PlanStepStatus = "pending" | "active" | "success" | "error";

export type PlanStep = {
  id: string;
  title: string;
  content?: ReactNode;
  status: PlanStepStatus;
  icon?: ReactNode;
  duration?: string;
  defaultExpanded?: boolean;
};

export type AgentPlanningProps = {
  title?: string;
  steps: PlanStep[];
  className?: string;
  variant?: "card" | "bare";
};

function statusColor(status: PlanStepStatus) {
  switch (status) {
    case "success":
      return "bg-emerald-500/20 text-emerald-400 ring-emerald-500/20";
    case "active":
      return "bg-sky-500/20 text-sky-400 ring-sky-500/30";
    case "error":
      return "bg-rose-500/20 text-rose-400 ring-rose-500/20";
    case "pending":
      return "bg-chip text-muted ring-border/50";
  }
}

export function AgentPlanning({
  title = "Friday is planning",
  steps,
  className,
  variant = "card",
}: AgentPlanningProps) {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(steps.map((s) => [s.id, Boolean(s.defaultExpanded)])),
  );

  const sig = steps.map((s) => `${s.id}:${s.status}:${s.defaultExpanded ? 1 : 0}`).join("|");
  useEffect(() => {
    setExpanded((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const step of steps) {
        if ((step.status === "active" || step.defaultExpanded) && !next[step.id]) {
          next[step.id] = true;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sig captures step status changes
  }, [sig]);

  const hasActive = steps.some((s) => s.status === "active");
  const allSuccess = steps.length > 0 && steps.every((s) => s.status === "success");

  return (
    <div className={cn("w-full font-sans text-foreground", className)}>
      <div
        className={cn(
          "overflow-hidden transition-all duration-300",
          variant === "card" &&
            "rounded-xl border border-border bg-composer shadow-[var(--shadow-composer)]",
        )}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "flex w-full items-center justify-between px-4 py-3.5 text-left transition-colors select-none",
            open ? "border-b border-border bg-chip/40" : "hover:bg-chip/30",
          )}
        >
          <div className="flex items-center gap-3">
            <div className="flex size-5 items-center justify-center">
              {hasActive ? (
                <Loader2 className="size-4 animate-spin text-sky-400" />
              ) : allSuccess ? (
                <Check className="size-4 text-emerald-400" />
              ) : (
                <BrainCircuit className="size-4 text-muted" />
              )}
            </div>
            <span className={cn("text-sm font-semibold tracking-tight", hasActive && "live-label")}>
              {title}
            </span>
          </div>
          <span className="flex size-6 items-center justify-center rounded-md text-muted">
            {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </span>
        </button>

        <div
          className={cn(
            "grid bg-composer transition-all duration-500 ease-in-out",
            open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
          )}
        >
          <div className="overflow-hidden">
            <div className="flex flex-col p-5">
              {steps.map((step, index) => {
                const stepOpen = Boolean(expanded[step.id]);
                const last = index === steps.length - 1;
                return (
                  <div
                    key={step.id}
                    className={cn(
                      "relative flex gap-4",
                      step.status === "pending" ? "opacity-55" : "opacity-100",
                    )}
                  >
                    {!last && (
                      <div className="absolute top-7 bottom-[-10px] left-[11px] z-0 w-0.5 bg-border" />
                    )}
                    <div className="relative z-10 mt-0.5 size-6 shrink-0">
                      <div
                        className={cn(
                          "flex size-full items-center justify-center rounded-full ring-4 ring-composer transition-colors duration-300",
                          statusColor(step.status),
                        )}
                      >
                        {step.status === "success" ? (
                          <Check className="size-3.5" />
                        ) : step.status === "active" ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          step.icon || <div className="size-1.5 rounded-full bg-current" />
                        )}
                      </div>
                    </div>
                    <div className="flex-1 pb-6">
                      <button
                        type="button"
                        disabled={!step.content}
                        onClick={() =>
                          setExpanded((prev) => ({ ...prev, [step.id]: !prev[step.id] }))
                        }
                        className={cn(
                          "group -mx-2 flex w-[calc(100%+1rem)] items-center justify-between rounded-md px-2 py-1 text-left transition-colors",
                          step.content && "hover:bg-chip/50",
                        )}
                      >
                        <span
                          className={cn(
                            "text-sm tracking-tight",
                            step.status === "active" && "font-semibold text-foreground",
                            step.status === "error" && "font-semibold text-rose-400",
                            step.status !== "active" &&
                              step.status !== "error" &&
                              "font-medium text-foreground/80",
                          )}
                        >
                          {step.title}
                        </span>
                        <span className="flex items-center gap-3">
                          {step.duration && (
                            <span className="font-mono text-[11px] text-muted tabular-nums">
                              {step.duration}
                            </span>
                          )}
                          {step.content && (
                            <span className="text-subtle group-hover:text-muted">
                              {stepOpen ? (
                                <ChevronDown className="size-4" />
                              ) : (
                                <ChevronRight className="size-4" />
                              )}
                            </span>
                          )}
                        </span>
                      </button>
                      {step.content && (
                        <div
                          className={cn(
                            "grid transition-all duration-300 ease-in-out",
                            stepOpen
                              ? "mt-2 grid-rows-[1fr] opacity-100"
                              : "mt-0 grid-rows-[0fr] opacity-0",
                          )}
                        >
                          <div className="overflow-hidden">
                            <div className="pt-1 pb-2">{step.content}</div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AgentPlanning;
