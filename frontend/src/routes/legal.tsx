import { useEffect } from "react";
import { SiteFooter, SiteHeader } from "@/routes/site";
import { POLICY_EFFECTIVE_DATE, PRIVACY_SECTIONS, TERMS_SECTIONS, type LegalSection } from "@/lib/site/legal";

function LegalDocument({ title, sections }: { title: string; sections: LegalSection[] }) {
  useEffect(() => {
    const previous = document.title;
    document.title = `${title} — Friday AI`;
    window.scrollTo(0, 0);
    return () => {
      document.title = previous;
    };
  }, [title]);

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <SiteHeader />
      <main className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
        <h1 className="font-[family-name:var(--font-heading)] text-3xl font-medium tracking-tight sm:text-4xl">{title}</h1>
        <p className="mt-3 text-sm text-subtle">Effective {POLICY_EFFECTIVE_DATE}</p>
        <div className="mt-10 space-y-9">
          {sections.map((section) => (
            <section key={section.heading}>
              <h2 className="text-lg font-medium">{section.heading}</h2>
              <div className="mt-2.5 space-y-3">
                {section.body.map((paragraph, i) => (
                  <p key={i} className="text-[15px] leading-relaxed text-muted">
                    {paragraph}
                  </p>
                ))}
              </div>
            </section>
          ))}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

export function PrivacyPage() {
  return <LegalDocument title="Privacy Policy" sections={PRIVACY_SECTIONS} />;
}

export function TermsPage() {
  return <LegalDocument title="Terms of Service" sections={TERMS_SECTIONS} />;
}
