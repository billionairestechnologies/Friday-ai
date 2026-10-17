import { ExternalLink } from "lucide-react";
import type { ExperienceId } from "@/lib/experiences/registry";
import { EmiCalculator } from "./emi-calculator";
import { OffsideSimulator } from "./offside-simulator";
import { ProjectileExplorer } from "./projectile-explorer";

/** Renders one allow-listed experience with already-validated params. */
export function ExperienceView({ id, params, compact, onChange }: { id: ExperienceId; params: Record<string, unknown>; compact?: boolean; onChange?: (p: Record<string, unknown>) => void }) {
  if (id === "offside") return <OffsideSimulator initial={params} compact={compact} onChange={onChange} />;
  if (id === "emi") return <EmiCalculator initial={params} compact={compact} onChange={onChange} />;
  return <ProjectileExplorer initial={params} compact={compact} onChange={onChange} />;
}

/** Params ride in the URL (base64 JSON) so an experience can be reopened or shared exactly as it was. */
export function encodeParams(params: Record<string, unknown>): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(params)))).replace(/=+$/, "");
}
export function decodeParams(s: string | null | undefined): unknown {
  if (!s) return undefined;
  try {
    return JSON.parse(decodeURIComponent(escape(atob(s))));
  } catch {
    return null;
  }
}

/** A `friday-experience` block inside a chat answer. */
export function ExperienceCard({ id, title, params }: { id: ExperienceId; title: string; params: Record<string, unknown> }) {
  return (
    <div className="my-3 overflow-hidden rounded-2xl border border-border bg-background">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <span className="text-sm font-semibold text-foreground">{title}</span>
        <a href={`/gallery/${id}?p=${encodeParams(params)}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground">
          Open full screen <ExternalLink className="size-3.5" />
        </a>
      </div>
      <div className="p-4">
        <ExperienceView id={id} params={params} compact />
      </div>
    </div>
  );
}
