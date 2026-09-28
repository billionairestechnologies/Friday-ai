import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, ChevronDown, Menu, X } from "lucide-react";
import { BrandMark, BrandWordmark } from "@/components/brand-mark";
import { SITE_NAV, SITE_PAGES, type SiteSlug } from "@/lib/site/pages";
import { cn } from "@/lib/utils";

export function SiteHeader({ active }: { active?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-30 border-b border-[var(--hairline)] bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Link to="/" className="flex items-center gap-2 text-foreground" aria-label="Friday home">
          <BrandMark className="size-7 text-[28px]" />
          <BrandWordmark className="text-lg" />
        </Link>
        <nav className="hidden flex-1 items-center gap-1 md:flex" aria-label="Friday">
          {SITE_NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                "rounded-full px-3 py-1.5 text-sm text-muted transition-colors hover:bg-[var(--surface-highlight)] hover:text-foreground",
                active === item.to && "text-foreground",
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2 md:ml-0">
          <Link
            to="/"
            className="inline-flex h-9 items-center rounded-full bg-foreground px-4 text-sm font-medium text-background transition-opacity hover:opacity-90"
          >
            Try Friday
          </Link>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="grid size-9 place-items-center rounded-full text-muted hover:bg-[var(--surface-highlight)] md:hidden"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
          >
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
      </div>
      {open && (
        <nav className="border-t border-[var(--hairline)] px-4 py-2 md:hidden" aria-label="Friday">
          {SITE_NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              onClick={() => setOpen(false)}
              className="block rounded-xl px-3 py-2.5 text-sm text-muted hover:bg-[var(--surface-highlight)] hover:text-foreground"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-[var(--hairline)]">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 sm:px-6 md:flex-row md:items-start md:justify-between">
        <div>
          <Link to="/" className="flex items-center gap-2 text-foreground">
            <BrandMark className="size-6 text-[24px]" />
            <BrandWordmark />
          </Link>
          <p className="mt-2 max-w-xs text-sm text-subtle">An AI assistant for every top model, by Billionaires Technologies.</p>
        </div>
        <nav className="grid grid-cols-2 gap-x-10 gap-y-2 text-sm sm:grid-cols-4" aria-label="Footer">
          {SITE_NAV.map((item) => (
            <Link key={item.to} to={item.to} className="text-muted hover:text-foreground">
              {item.label}
            </Link>
          ))}
          <Link to="/" className="text-muted hover:text-foreground">
            Chat
          </Link>
        </nav>
      </div>
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 pb-8 text-xs text-subtle sm:px-6">
        <span>© {new Date().getFullYear()} Billionaires Technologies</span>
        <Link to="/privacy" className="hover:text-foreground">
          Privacy Policy
        </Link>
        <Link to="/terms" className="hover:text-foreground">
          Terms of Service
        </Link>
      </div>
    </footer>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-[var(--hairline)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-4 py-4 text-left text-foreground"
        aria-expanded={open}
      >
        <span className="font-medium">{q}</span>
        <ChevronDown className={cn("size-4 shrink-0 text-subtle transition-transform", open && "rotate-180")} />
      </button>
      {/* Always in the DOM (just visually collapsed) so the answers stay readable to crawlers. */}
      <p className={cn("pb-4 text-sm leading-relaxed text-muted", !open && "sr-only")}>{a}</p>
    </div>
  );
}

export function SitePage({ slug }: { slug: SiteSlug }) {
  const page = SITE_PAGES[slug];

  useEffect(() => {
    const previous = document.title;
    document.title = page.metaTitle;
    window.scrollTo(0, 0);
    return () => {
      document.title = previous;
    };
  }, [page.metaTitle]);

  // FAQPage structured data — lets Google show these Q&As as an expandable list directly in the
  // search result. Injected client-side (this whole site is CSR) rather than duplicated into
  // backend/src/seo.ts: Googlebot renders the page before reading structured data, and the
  // homepage's JSON-LD already proved that out (indexed fine per Search Console). One script tag
  // per page, swapped out on navigation so a stale page's FAQ never lingers.
  useEffect(() => {
    const script = document.createElement("script");
    script.type = "application/ld+json";
    script.text = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: page.faq.map((item) => ({
        "@type": "Question",
        name: item.q,
        acceptedAnswer: { "@type": "Answer", text: item.a },
      })),
    });
    document.head.appendChild(script);
    return () => {
      document.head.removeChild(script);
    };
  }, [page.faq]);

  return (
    <div className="min-h-dvh overflow-x-hidden bg-background text-foreground">
      <SiteHeader active={`/${slug}`} />
      <main>
        <section className="relative">
          <div className="ambient-glow" aria-hidden />
          <div className="relative mx-auto max-w-4xl px-4 pb-16 pt-20 text-center sm:px-6 sm:pt-28">
            <p className="text-sm font-medium tracking-wide text-primary">{page.eyebrow}</p>
            <h1 className="mt-4 text-balance font-[family-name:var(--font-heading)] text-4xl font-medium tracking-tight sm:text-6xl">
              {page.headline}
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-muted">{page.lead}</p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <Link
                to="/"
                className="inline-flex h-12 items-center gap-2 rounded-full bg-foreground px-6 font-medium text-background transition-opacity hover:opacity-90"
              >
                {page.cta}
                <ArrowRight className="size-4" />
              </Link>
              <Link
                to="/plans"
                className="inline-flex h-12 items-center rounded-full border border-border px-6 font-medium text-foreground transition-colors hover:bg-[var(--surface-highlight)]"
              >
                See plans
              </Link>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {page.features.map(({ icon: Icon, title, body }) => (
              <article key={title} className="rounded-[var(--radius-xl)] border border-[var(--hairline)] bg-surface p-6">
                <div className="grid size-10 place-items-center rounded-xl bg-elevated text-foreground">
                  <Icon className="size-5" />
                </div>
                <h2 className="mt-5 text-lg font-medium">{title}</h2>
                <p className="mt-2 text-sm leading-relaxed text-muted">{body}</p>
              </article>
            ))}
          </div>
        </section>

        {page.steps && (
          <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
            <h2 className="text-center font-[family-name:var(--font-heading)] text-2xl font-medium tracking-tight sm:text-3xl">
              {slug === "automations" ? "Ideas to start with" : "How it works"}
            </h2>
            <ol className="mt-10 grid gap-4 md:grid-cols-3">
              {page.steps.map((step, i) => (
                <li key={step.title} className="rounded-[var(--radius-xl)] border border-[var(--hairline)] p-6">
                  <span className="text-sm tabular-nums text-subtle">{String(i + 1).padStart(2, "0")}</span>
                  <h3 className="mt-3 font-medium">{step.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{step.body}</p>
                </li>
              ))}
            </ol>
          </section>
        )}

        <section className="mx-auto max-w-3xl px-4 pb-24 sm:px-6">
          <h2 className="text-center font-[family-name:var(--font-heading)] text-2xl font-medium tracking-tight sm:text-3xl">Questions</h2>
          <div className="mt-8 border-t border-[var(--hairline)]">
            {page.faq.map((item) => (
              <FaqItem key={item.q} {...item} />
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-4xl px-4 pb-24 text-center sm:px-6">
          <div className="rounded-[var(--radius-2xl)] border border-[var(--hairline)] bg-surface px-6 py-14">
            <h2 className="text-balance font-[family-name:var(--font-heading)] text-3xl font-medium tracking-tight">Try Friday free</h2>
            <p className="mx-auto mt-3 max-w-md text-muted">No card needed. Upgrade when you want more.</p>
            <Link
              to="/"
              className="mt-8 inline-flex h-12 items-center gap-2 rounded-full bg-foreground px-6 font-medium text-background transition-opacity hover:opacity-90"
            >
              Start chatting
              <ArrowRight className="size-4" />
            </Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
