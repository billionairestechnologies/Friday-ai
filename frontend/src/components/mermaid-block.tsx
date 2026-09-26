import { useEffect, useId, useState, type ReactNode } from "react";
import { Check, Copy, Download } from "lucide-react";
import { saveFile } from "@/lib/chat/download";

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
function loadMermaid() {
  mermaidPromise ??= import("mermaid").then((m) => m.default);
  return mermaidPromise;
}

function isDark(): boolean {
  const root = document.documentElement;
  if (root.dataset.theme) return root.dataset.theme === "dark";
  return root.classList.contains("dark") || window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Renders a ```mermaid block as a diagram. While the text is still streaming (or is invalid) it
 *  shows the normal code block instead, so a half-written diagram never flashes an error. */
export function MermaidBlock({ text, fallback }: { text: string; fallback: ReactNode }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const mermaid = await loadMermaid();
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: isDark() ? "dark" : "neutral", fontFamily: "inherit" });
        const out = await mermaid.render(`mmd${id}${Date.now()}`, text);
        if (!cancelled) setSvg(out.svg);
      } catch {
        if (!cancelled) setSvg(null);
        document.getElementById(`dmmd${id}`)?.remove();
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text, id]);

  if (!svg) return <>{fallback}</>;
  return (
    <div className="my-3 overflow-hidden rounded-2xl border border-border bg-elevated">
      <div className="flex items-center justify-between gap-2 border-b border-border px-[18px] py-2.5">
        <span className="font-mono text-xs text-muted">diagram</span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            aria-label="Copy diagram code"
            className="rounded-full p-1.5 text-muted hover:bg-chip hover:text-foreground"
            onClick={async () => {
              await navigator.clipboard.writeText(text);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </button>
          <button
            type="button"
            aria-label="Download diagram"
            className="rounded-full p-1.5 text-muted hover:bg-chip hover:text-foreground"
            onClick={() => void saveFile("diagram.svg", svg)}
          >
            <Download className="size-3.5" />
          </button>
        </div>
      </div>
      <div className="overflow-x-auto p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}
