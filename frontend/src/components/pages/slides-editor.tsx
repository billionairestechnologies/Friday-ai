import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Copy, Plus, Trash2 } from "lucide-react";
import type { SlideLayout, SlideSpec, SlidesContent } from "@/lib/pages/api";
import { cn } from "@/lib/utils";

/**
 * The slide-deck editor: a slide strip, a 16:9 live preview and the selected slide's fields. Slides
 * keep the same structured shape the .pptx renderer and Friday's tools use (layout + title, bullets,
 * columns, stats, quote, table, chart, speaker notes), so what you see here is what exports.
 */

const LAYOUTS: { id: SlideLayout; label: string }[] = [
  { id: "title", label: "Title" },
  { id: "section", label: "Section" },
  { id: "bullets", label: "Bullets" },
  { id: "two_column", label: "Two columns" },
  { id: "stats", label: "Stats" },
  { id: "quote", label: "Quote" },
  { id: "table", label: "Table" },
  { id: "chart", label: "Chart" },
];

const DEFAULT_ACCENT = "#4F46E5";
const layoutOf = (s: SlideSpec, i: number): SlideLayout =>
  s.layout ?? (i === 0 ? "title" : s.stats ? "stats" : s.chart ? "chart" : s.table ? "table" : s.left || s.right ? "two_column" : s.quote ? "quote" : "bullets");

const lines = (v: string) => v.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());

export function SlidesEditor({ content, onChange, readOnly = false }: { content: SlidesContent; onChange?: (c: SlidesContent) => void; readOnly?: boolean }) {
  const slides = content.slides.length ? content.slides : [{ layout: "title" as const, title: "Untitled" }];
  const [index, setIndex] = useState(0);
  const i = Math.min(index, slides.length - 1);
  const slide = slides[i]!;
  const accent = /^#[0-9a-f]{6}$/i.test(content.theme_color ?? "") ? content.theme_color! : DEFAULT_ACCENT;

  useEffect(() => {
    if (index >= slides.length) setIndex(slides.length - 1);
  }, [index, slides.length]);

  const setSlides = (next: SlideSpec[]) => onChange?.({ ...content, slides: next });
  const patch = (p: Partial<SlideSpec>) => setSlides(slides.map((s, j) => (j === i ? { ...s, ...p } : s)));
  const move = (d: number) => {
    const j = i + d;
    if (j < 0 || j >= slides.length) return;
    const next = [...slides];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setSlides(next);
    setIndex(j);
  };

  if (readOnly) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-8">
          {slides.map((s, j) => (
            <SlidePreview key={j} slide={s} layout={layoutOf(s, j)} accent={accent} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside className="flex shrink-0 gap-2 overflow-x-auto border-b border-border p-3 md:w-52 md:flex-col md:overflow-y-auto md:border-r md:border-b-0">
        {slides.map((s, j) => (
          <button
            key={j}
            type="button"
            onClick={() => setIndex(j)}
            className={cn("flex w-36 shrink-0 flex-col gap-1 rounded-xl p-1.5 text-left md:w-full", j === i ? "bg-chip-on" : "hover:bg-chip")}
            aria-label={`Slide ${j + 1}`}
          >
            <div className="pointer-events-none overflow-hidden rounded-md border border-border">
              <SlidePreview slide={s} layout={layoutOf(s, j)} accent={accent} compact />
            </div>
            <span className="truncate px-0.5 text-xs text-muted">
              {j + 1}. {s.title || "Untitled"}
            </span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            setSlides([...slides.slice(0, i + 1), { layout: "bullets", title: "New slide", bullets: ["First point"] }, ...slides.slice(i + 1)]);
            setIndex(i + 1);
          }}
          className="flex h-10 w-36 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-dashed border-border text-sm text-muted hover:text-foreground md:w-full"
        >
          <Plus className="size-4" /> Slide
        </button>
      </aside>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-5 px-4 py-6">
          <div className="overflow-hidden rounded-xl border border-border shadow-sm">
            <SlidePreview slide={slide} layout={layoutOf(slide, i)} accent={accent} />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Layout"
              value={layoutOf(slide, i)}
              onChange={(e) => patch({ layout: e.target.value as SlideLayout })}
              className="h-9 rounded-lg border border-border bg-composer px-2 text-sm text-foreground"
            >
              {LAYOUTS.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
            <label className="flex h-9 items-center gap-2 rounded-lg border border-border px-2 text-xs text-muted">
              Accent
              <input type="color" value={accent} onChange={(e) => onChange?.({ ...content, theme_color: e.target.value })} className="size-6 cursor-pointer bg-transparent" />
            </label>
            <div className="ml-auto flex items-center gap-1">
              <IconButton label="Move up" onClick={() => move(-1)} disabled={i === 0}>
                <ArrowUp className="size-4" />
              </IconButton>
              <IconButton label="Move down" onClick={() => move(1)} disabled={i === slides.length - 1}>
                <ArrowDown className="size-4" />
              </IconButton>
              <IconButton
                label="Duplicate slide"
                onClick={() => {
                  setSlides([...slides.slice(0, i + 1), structuredClone(slide), ...slides.slice(i + 1)]);
                  setIndex(i + 1);
                }}
              >
                <Copy className="size-4" />
              </IconButton>
              <IconButton
                label="Delete slide"
                disabled={slides.length <= 1}
                onClick={() => {
                  setSlides(slides.filter((_, j) => j !== i));
                  setIndex(Math.max(0, i - 1));
                }}
              >
                <Trash2 className="size-4" />
              </IconButton>
            </div>
          </div>

          <SlideFields slide={slide} layout={layoutOf(slide, i)} patch={patch} />
        </div>
      </div>
    </div>
  );
}

function SlideFields({ slide, layout, patch }: { slide: SlideSpec; layout: SlideLayout; patch: (p: Partial<SlideSpec>) => void }) {
  return (
    <div className="grid gap-3">
      <Field label="Title" value={slide.title ?? ""} onChange={(v) => patch({ title: v })} />
      {(layout === "title" || layout === "section") && <Field label="Subtitle" value={slide.subtitle ?? ""} onChange={(v) => patch({ subtitle: v })} />}
      {layout === "bullets" && <ListField label="Bullets (one per line)" value={slide.bullets ?? []} onChange={(v) => patch({ bullets: v })} />}
      {layout === "two_column" && (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="grid gap-2">
            <Field label="Left heading" value={slide.left_title ?? ""} onChange={(v) => patch({ left_title: v })} />
            <ListField label="Left points" value={slide.left ?? []} onChange={(v) => patch({ left: v })} />
          </div>
          <div className="grid gap-2">
            <Field label="Right heading" value={slide.right_title ?? ""} onChange={(v) => patch({ right_title: v })} />
            <ListField label="Right points" value={slide.right ?? []} onChange={(v) => patch({ right: v })} />
          </div>
        </div>
      )}
      {layout === "stats" && (
        <TextField
          label="Stats — one per line: value | label"
          value={(slide.stats ?? []).map((s) => `${s.value} | ${s.label}`).join("\n")}
          onChange={(v) =>
            patch({
              stats: lines(v).map((l) => {
                const [value, ...rest] = l.split("|");
                return { value: (value ?? "").trim(), label: rest.join("|").trim() };
              }),
            })
          }
        />
      )}
      {layout === "quote" && <TextField label="Quote" value={slide.quote ?? ""} onChange={(v) => patch({ quote: v })} />}
      {layout === "table" && (
        <TextField
          label="Table — one row per line, cells separated by | (first row is the header)"
          value={(slide.table ?? []).map((r) => r.join(" | ")).join("\n")}
          onChange={(v) => patch({ table: lines(v).map((l) => l.split("|").map((c) => c.trim())) })}
          mono
        />
      )}
      {layout === "chart" && (
        <div className="grid gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted">Chart type</span>
            <select
              aria-label="Chart type"
              value={slide.chart?.type ?? "bar"}
              onChange={(e) => patch({ chart: { ...slide.chart, type: e.target.value as "bar" } })}
              className="h-8 rounded-lg border border-border bg-composer px-2 text-sm text-foreground"
            >
              {["bar", "line", "pie", "doughnut"].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </div>
          <Field label="Labels (comma separated)" value={(slide.chart?.labels ?? []).join(", ")} onChange={(v) => patch({ chart: { ...slide.chart, labels: v.split(",").map((x) => x.trim()) } })} />
          <TextField
            label="Series — one per line: name: 1, 2, 3"
            value={(slide.chart?.series ?? []).map((s) => `${s.name ?? "Series"}: ${(s.values ?? []).join(", ")}`).join("\n")}
            onChange={(v) =>
              patch({
                chart: {
                  ...slide.chart,
                  series: lines(v).map((l) => {
                    const at = l.indexOf(":");
                    const name = at >= 0 ? l.slice(0, at).trim() : "Series";
                    const values = (at >= 0 ? l.slice(at + 1) : l).split(",").map((x) => Number(x.trim()) || 0);
                    return { name, values };
                  }),
                },
              })
            }
            mono
          />
        </div>
      )}
      <TextField label="Speaker notes" value={slide.notes ?? ""} onChange={(v) => patch({ notes: v })} />
    </div>
  );
}

/** Text areas keep their own draft so "one per line" fields don't eat a half-typed empty line. */
function TextField({ label, value, onChange, mono }: { label: string; value: string; onChange: (v: string) => void; mono?: boolean }) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(value);
  }, [value, focused]);
  return (
    <label className="grid gap-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      <textarea
        value={draft}
        rows={Math.min(10, Math.max(3, draft.split("\n").length + 1))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          setDraft(e.target.value);
          onChange(e.target.value);
        }}
        className={cn("rounded-lg border border-border bg-composer px-3 py-2 text-sm text-foreground outline-none focus:border-foreground/30", mono && "font-mono text-xs")}
      />
    </label>
  );
}

function ListField({ label, value, onChange }: { label: string; value: string[]; onChange: (v: string[]) => void }) {
  return <TextField label={label} value={value.join("\n")} onChange={(v) => onChange(lines(v))} />;
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="grid gap-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} className="h-9 rounded-lg border border-border bg-composer px-3 text-sm text-foreground outline-none focus:border-foreground/30" />
    </label>
  );
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} disabled={disabled} className="flex size-9 items-center justify-center rounded-lg text-muted hover:bg-chip hover:text-foreground disabled:opacity-35">
      {children}
    </button>
  );
}

/**
 * A 16:9 slide drawn with container-query units so it scales from a thumbnail to full width. Colours
 * are fixed (white slide, accent title slides) like the exported deck, not the app theme.
 */
export function SlidePreview({ slide, layout, accent, compact }: { slide: SlideSpec; layout: SlideLayout; accent: string; compact?: boolean }) {
  const accentSlide = layout === "title" || layout === "section";
  return (
    <div className="@container relative aspect-video w-full overflow-hidden" style={{ background: accentSlide ? accent : "#ffffff", color: accentSlide ? "#ffffff" : "#111827" }}>
      <div className="absolute inset-0 flex flex-col p-[5cqw]" style={{ fontSize: compact ? "2.6cqw" : "2.2cqw" }}>
        {accentSlide ? (
          <div className="flex flex-1 flex-col justify-center">
            <div className="font-bold leading-tight" style={{ fontSize: layout === "title" ? "5.2cqw" : "4.2cqw" }}>
              {slide.title || "Untitled"}
            </div>
            {slide.subtitle && <div className="mt-[1.5cqw] opacity-85" style={{ fontSize: "2.4cqw" }}>{slide.subtitle}</div>}
          </div>
        ) : (
          <>
            <div className="font-bold leading-tight" style={{ fontSize: "3.6cqw", color: "#111827" }}>
              {slide.title}
            </div>
            <div className="mt-[0.8cqw] h-[0.4cqw] w-[8cqw] rounded-full" style={{ background: accent }} />
            <div className="mt-[2.5cqw] min-h-0 flex-1 overflow-hidden">
              <SlideBody slide={slide} layout={layout} accent={accent} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="flex flex-col gap-[1cqw]">
      {items.map((b, j) => (
        <li key={j} className="flex gap-[1.2cqw] leading-snug">
          <span className="mt-[0.9cqw] size-[0.8cqw] shrink-0 rounded-full bg-current opacity-60" />
          <span>{b}</span>
        </li>
      ))}
    </ul>
  );
}

function SlideBody({ slide, layout, accent }: { slide: SlideSpec; layout: SlideLayout; accent: string }) {
  if (layout === "two_column") {
    return (
      <div className="grid h-full grid-cols-2 gap-[4cqw]">
        {[
          [slide.left_title, slide.left],
          [slide.right_title, slide.right],
        ].map(([t, items], j) => (
          <div key={j}>
            {t && <div className="mb-[1.2cqw] font-semibold" style={{ color: accent }}>{t as string}</div>}
            <Bullets items={(items as string[] | undefined) ?? []} />
          </div>
        ))}
      </div>
    );
  }
  if (layout === "stats") {
    return (
      <div className="flex h-full items-center justify-around gap-[3cqw]">
        {(slide.stats ?? []).slice(0, 4).map((s, j) => (
          <div key={j} className="text-center">
            <div className="font-bold" style={{ fontSize: "5cqw", color: accent }}>{s.value}</div>
            <div className="mt-[0.8cqw] opacity-70">{s.label}</div>
          </div>
        ))}
      </div>
    );
  }
  if (layout === "quote") {
    return (
      <div className="flex h-full items-center">
        <blockquote className="border-l-[0.6cqw] pl-[2.5cqw] italic" style={{ borderColor: accent, fontSize: "3cqw" }}>
          “{slide.quote}”
        </blockquote>
      </div>
    );
  }
  if (layout === "table") {
    const [head, ...body] = slide.table ?? [];
    return (
      <table className="w-full border-collapse" style={{ fontSize: "1.8cqw" }}>
        {head && (
          <thead>
            <tr>
              {head.map((h, j) => (
                <th key={j} className="px-[1cqw] py-[0.6cqw] text-left font-semibold text-white" style={{ background: accent }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {body.slice(0, 10).map((r, j) => (
            <tr key={j} style={{ background: j % 2 ? "#f3f4f6" : "#ffffff" }}>
              {r.map((c, k) => (
                <td key={k} className="px-[1cqw] py-[0.6cqw]">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (layout === "chart") return <MiniChart chart={slide.chart} accent={accent} />;
  return <Bullets items={slide.bullets ?? []} />;
}

const PALETTE = ["#4F46E5", "#0EA5E9", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6"];

/** A simple bar/line preview — the exported .pptx gets a real native chart. */
function MiniChart({ chart, accent }: { chart: SlideSpec["chart"]; accent: string }) {
  const labels = chart?.labels ?? [];
  const series = (chart?.series ?? []).map((s) => (s.values ?? []).map((v) => Number(v) || 0));
  const max = Math.max(1, ...series.flat());
  if (!labels.length || !series.length) return <div className="flex h-full items-center justify-center opacity-50">Add labels and a series</div>;
  const colors = [accent, ...PALETTE.filter((c) => c.toLowerCase() !== accent.toLowerCase())];
  return (
    <div className="flex h-full flex-col">
      <svg viewBox="0 0 100 50" preserveAspectRatio="none" className="min-h-0 w-full flex-1">
        {chart?.type === "line"
          ? series.map((vals, s) => (
              <polyline
                key={s}
                fill="none"
                stroke={colors[s % colors.length]}
                strokeWidth={0.8}
                points={vals.map((v, j) => `${(j / Math.max(1, labels.length - 1)) * 100},${50 - (v / max) * 48}`).join(" ")}
              />
            ))
          : labels.map((_, j) =>
              series.map((vals, s) => {
                const groupW = 100 / labels.length;
                const barW = (groupW * 0.7) / series.length;
                const h = ((vals[j] ?? 0) / max) * 48;
                return <rect key={`${j}-${s}`} x={j * groupW + groupW * 0.15 + s * barW} y={50 - h} width={barW} height={h} fill={colors[s % colors.length]} />;
              }),
            )}
      </svg>
      <div className="mt-[0.8cqw] flex justify-around opacity-70" style={{ fontSize: "1.5cqw" }}>
        {labels.map((l, j) => (
          <span key={j} className="truncate">
            {l}
          </span>
        ))}
      </div>
    </div>
  );
}
