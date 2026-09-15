import { cn } from "@/lib/utils";

export function SparkMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("fill-current", className)}
      aria-hidden
    >
      <path d="M12 1.6 13.85 9.2 21.6 12 13.85 14.8 12 22.4 10.15 14.8 2.4 12 10.15 9.2Z" />
    </svg>
  );
}
