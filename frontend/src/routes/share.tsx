import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Markdown } from "@/lib/chat/markdown";
import { API_BASE_URL } from "@/lib/api";
import { BrandWordmark } from "@/components/brand-mark";

type Shared = {
  title: string;
  sharedAt: string;
  messages: { role: "user" | "assistant"; content: string; model: string | null; createdAt: string }[];
};

/** Public read-only view of a shared chat (no sign-in needed). */
export function SharePage({ token }: { token: string }) {
  const navigate = useNavigate();
  const [data, setData] = useState<Shared | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE_URL}/share/${encodeURIComponent(token)}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as Shared & { error?: string };
        if (!res.ok) throw new Error(body.error || "This link doesn't exist or was turned off");
        setData(body);
        document.title = `${body.title} · Friday`;
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load this chat"));
  }, [token]);

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-border bg-background/90 px-4 backdrop-blur">
        <BrandWordmark />
        <button
          type="button"
          onClick={() => void navigate({ to: "/" })}
          className="h-9 rounded-full bg-foreground px-4 text-sm font-medium text-background"
        >
          Try Friday
        </button>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-8">
        {error && <p className="text-center text-sm text-muted">{error}</p>}
        {!data && !error && <p className="text-center text-sm text-muted">Loading…</p>}
        {data && (
          <>
            <h1 className="mb-1 text-xl font-semibold">{data.title}</h1>
            <p className="mb-8 text-xs text-subtle">Shared conversation · read-only</p>
            <div className="flex flex-col gap-6">
              {data.messages.map((m, i) =>
                m.role === "user" ? (
                  <div key={i} className="ml-auto max-w-[85%] rounded-2xl bg-chip px-4 py-2.5 text-sm whitespace-pre-wrap">
                    {m.content}
                  </div>
                ) : (
                  <div key={i} className="min-w-0">
                    {m.model && <p className="mb-1 text-xs text-subtle">{m.model}</p>}
                    <Markdown text={m.content} />
                  </div>
                ),
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
