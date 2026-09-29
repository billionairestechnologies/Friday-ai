import { useEffect } from "react";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { RotateCw, TriangleAlert } from "lucide-react";
import { reportCrash } from "@/lib/crash";

const FALLBACK_MESSAGE = "An unexpected error occurred. Try reloading the page.";

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return FALLBACK_MESSAGE;
}

export function AppErrorComponent({ error }: ErrorComponentProps) {
  // The team sees this crash in the console (Status → Crashes) — no need for the user to report it.
  useEffect(() => reportCrash(error, { source: "error screen" }), [error]);
  return (
    <main
      className={
        "flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center " +
        "bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50"
      }
    >
      <span className="text-red-500" aria-hidden="true">
        <TriangleAlert className="size-10" strokeWidth={2} />
      </span>
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <p className="max-w-md text-sm break-words text-zinc-500 dark:text-zinc-400">{errorMessage(error)}</p>
      <p className="max-w-md text-xs text-zinc-500 dark:text-zinc-400">We've been notified automatically.</p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex h-10 items-center gap-2 rounded-full bg-zinc-900 px-4 text-sm font-medium text-white dark:bg-zinc-50 dark:text-zinc-900"
        >
          <RotateCw className="size-4" /> Reload
        </button>
        <a href="/status?report=1" className="inline-flex h-10 items-center rounded-full border border-zinc-300 px-4 text-sm dark:border-zinc-700">
          Report a problem
        </a>
      </div>
    </main>
  );
}
