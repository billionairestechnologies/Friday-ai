import { useState } from "react";
import { motion } from "framer-motion";
import { Download, FileCode2, FileSpreadsheet, FileText, Loader2, Presentation } from "lucide-react";
import { API_BASE_URL, getAccessToken } from "@/lib/api";
import type { GeneratedFile } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

/**
 * Download cards for files Friday generated (create_document). The same card is used under a reply
 * and in the Library. Downloads go through the authenticated API (files are private to their owner).
 */

export const FORMAT_STYLE: Record<string, { label: string; color: string; bg: string; icon: typeof FileText }> = {
  pptx: { label: "PowerPoint", color: "#D24726", bg: "rgba(210,71,38,0.12)", icon: Presentation },
  xlsx: { label: "Excel", color: "#107C41", bg: "rgba(16,124,65,0.12)", icon: FileSpreadsheet },
  csv: { label: "CSV", color: "#107C41", bg: "rgba(16,124,65,0.12)", icon: FileSpreadsheet },
  docx: { label: "Word", color: "#185ABD", bg: "rgba(24,90,189,0.12)", icon: FileText },
  pdf: { label: "PDF", color: "#D93025", bg: "rgba(217,48,37,0.12)", icon: FileText },
  md: { label: "Markdown", color: "#6B7280", bg: "rgba(107,114,128,0.14)", icon: FileText },
  txt: { label: "Text", color: "#6B7280", bg: "rgba(107,114,128,0.14)", icon: FileText },
  xml: { label: "XML", color: "#B45309", bg: "rgba(180,83,9,0.12)", icon: FileCode2 },
  json: { label: "JSON", color: "#B45309", bg: "rgba(180,83,9,0.12)", icon: FileCode2 },
  html: { label: "HTML", color: "#E34F26", bg: "rgba(227,79,38,0.12)", icon: FileCode2 },
};

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${+(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export async function downloadGeneratedFile(id: string, fallbackName: string): Promise<void> {
  const token = getAccessToken();
  const res = await fetch(`${API_BASE_URL}/files/${id}/download`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (res.status === 404) throw new Error("This file was deleted from your Library");
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = fallbackName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function FileIcon({ format, className }: { format: string; className?: string }) {
  const style = FORMAT_STYLE[format] ?? FORMAT_STYLE.txt!;
  const Icon = style.icon;
  return (
    <span className={cn("relative flex shrink-0 items-center justify-center rounded-xl", className ?? "size-11")} style={{ background: style.bg, color: style.color }}>
      <Icon className="size-5" strokeWidth={1.75} />
      <span className="absolute -bottom-1 rounded-[4px] px-1 text-[8px] leading-[12px] font-bold tracking-wide text-white uppercase" style={{ background: style.color }}>
        {format}
      </span>
    </span>
  );
}

export function FileCard({ file, index = 0 }: { file: GeneratedFile; index?: number }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const style = FORMAT_STYLE[file.format] ?? FORMAT_STYLE.txt!;
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: index * 0.05 }} className="w-full max-w-md">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await downloadGeneratedFile(file.id, file.filename);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Download failed");
          } finally {
            setBusy(false);
          }
        }}
        className="group flex w-full items-center gap-3 rounded-2xl border border-border bg-composer px-3.5 py-3 text-left transition-colors hover:bg-chip"
      >
        {/* Code/config files are stored as txt but keep their real extension (.py, .xaml…) — show that. */}
        <FileIcon format={file.format === "txt" ? (file.filename.split(".").pop() ?? "txt").slice(0, 5) : file.format} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">{file.filename}</div>
          <div className="truncate text-xs text-muted">
            {style.label}
            {file.summary ? ` · ${file.summary}` : ""} · {formatBytes(file.size)}
          </div>
        </div>
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border text-muted transition-colors group-hover:text-foreground">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
        </span>
      </button>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </motion.div>
  );
}

export function FileCards({ files }: { files: GeneratedFile[] }) {
  if (!files.length) return null;
  return (
    <div className="flex w-full flex-col gap-2">
      {files.map((f, i) => (
        <FileCard key={f.id} file={f} index={i} />
      ))}
    </div>
  );
}
