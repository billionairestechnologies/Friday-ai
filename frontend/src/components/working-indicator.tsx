import { cn } from "@/lib/utils";
import { useLiveStream } from "@/lib/chat/live-stream";

/** The round "still working" ring shown beside a chat in the history until its answer is done. */
export function WorkingSpinner({ className, label = "Working" }: { className?: string; label?: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className={cn("inline-block size-3.5 shrink-0 animate-spin rounded-full border-2 border-sky-500/25 border-t-sky-500", className)}
    />
  );
}

/** True while this chat has a live reply streaming in this browser (cleared the moment it finishes). */
export function useIsWorking(chatId: string | null | undefined): boolean {
  return useLiveStream(chatId) !== null;
}
