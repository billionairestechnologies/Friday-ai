import { cn } from "@/lib/utils";

/** Friday's brand mark — a monogram badge, used wherever the sidebar/dashboard needs a logo. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "relative grid shrink-0 place-items-center overflow-hidden rounded-[9px]",
        "bg-gradient-to-br from-foreground to-foreground/70",
        className,
      )}
      aria-hidden
    >
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-transparent via-transparent to-white/20" />
      <span className="relative text-[0.62em] leading-none font-extrabold text-background">F</span>
    </div>
  );
}

/** The "Friday" wordmark, styled distinctly from body copy so it reads as a brand, not a label. */
export function BrandWordmark({ className }: { className?: string }) {
  return (
    <span className={cn("text-[1.05em] font-extrabold tracking-tighter", className)}>Friday</span>
  );
}
