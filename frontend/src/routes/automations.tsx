import { useNavigate } from "@tanstack/react-router";
import { Workflow, X } from "lucide-react";

export function AutomationsPage() {
  const navigate = useNavigate();
  return (
    <div className="min-h-dvh bg-background px-4 py-10 text-foreground md:px-8">
      <button
        type="button"
        onClick={() => void navigate({ to: "/" })}
        aria-label="Close"
        className="fixed top-4 right-4 flex size-9 items-center justify-center rounded-full text-muted transition-colors hover:bg-chip hover:text-foreground"
      >
        <X className="size-5" />
      </button>
      <div className="mx-auto flex max-w-2xl flex-col items-center gap-4 pt-24 text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-chip">
          <Workflow className="size-6 text-muted" />
        </div>
        <h1 className="text-xl font-semibold">Automations</h1>
        <p className="max-w-sm text-sm text-muted">
          Scheduled and triggered Friday runs — set it up once, let it work in the background. Coming soon.
        </p>
      </div>
    </div>
  );
}
