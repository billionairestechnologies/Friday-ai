import { memo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, Download } from "lucide-react";
import { filenameForLang, saveFile } from "@/lib/chat/download";
import { cn } from "@/lib/utils";

function IconAction({
  label,
  doneLabel,
  onPress,
  icon: Icon,
}: {
  label: string;
  doneLabel: string;
  onPress: () => void | Promise<void>;
  icon: typeof Copy;
}) {
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex size-8 items-center justify-center rounded-[8px] text-muted opacity-80 transition-[opacity,background-color,color] duration-150 hover:bg-chip hover:text-foreground hover:opacity-100"
      aria-label={ok ? doneLabel : label}
      onClick={async () => {
        await onPress();
        setOk(true);
        window.setTimeout(() => setOk(false), 1400);
      }}
    >
      {ok ? <Check className="size-3.5 text-emerald-400" /> : <Icon className="size-3.5" />}
    </button>
  );
}

function CodeActions({ text, lang }: { text: string; lang?: string }) {
  return (
    <div className="absolute top-2 right-2 z-10 flex items-center gap-0.5 rounded-lg border border-border bg-elevated p-0.5">
      <IconAction
        label="Copy code"
        doneLabel="Copied"
        icon={Copy}
        onPress={async () => {
          await navigator.clipboard.writeText(text);
        }}
      />
      <IconAction
        label="Download code"
        doneLabel="Downloaded"
        icon={Download}
        onPress={() => void saveFile(filenameForLang(lang), text)}
      />
    </div>
  );
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          pre: ({ children }) => (
            <pre className="relative min-h-[2.5rem] pr-24">{children}</pre>
          ),
          code: ({ className, children, ...props }) => {
            const value = String(children).replace(/\n$/, "");
            const isBlock = Boolean(className) || value.includes("\n");
            if (!isBlock) {
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            }
            const lang = /language-([a-z0-9+#-]+)/i.exec(className ?? "")?.[1];
            return (
              <code className={cn("block", className)} {...props}>
                <CodeActions text={value} lang={lang} />
                {children}
              </code>
            );
          },
          table: ({ children }) => (
            <div className="my-3 min-h-[3rem] overflow-x-auto">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

export function splitStreamingMarkdown(text: string) {
  const fences = text.match(/```/g)?.length ?? 0;
  if (fences % 2 === 1) {
    const i = text.lastIndexOf("```");
    return { stable: text.slice(0, i), tail: text.slice(i) };
  }
  const nl = text.lastIndexOf("\n\n");
  if (nl >= 0) {
    return { stable: text.slice(0, nl + 2), tail: text.slice(nl + 2) };
  }
  return { stable: "", tail: text };
}

export const StreamingMarkdown = memo(function StreamingMarkdown({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  const committedRef = useRef("");

  if (!streaming) {
    committedRef.current = "";
    return (
      <div className="relative min-h-[1.65em] w-full">
        <Markdown text={text} />
      </div>
    );
  }

  const { stable } = splitStreamingMarkdown(text);
  if (stable.startsWith(committedRef.current)) {
    committedRef.current = stable;
  } else if (!text.startsWith(committedRef.current)) {
    committedRef.current = stable;
  }
  const prefix = committedRef.current;
  const rest = text.startsWith(prefix) ? text.slice(prefix.length) : text;

  return (
    <div className="relative min-h-[1.65em] w-full [overflow-anchor:none]">
      {prefix ? <Markdown text={prefix} /> : null}
      <span className="md whitespace-pre-wrap text-[0.975rem] leading-[1.65]">
        {rest}
        <span className="stream-caret" aria-hidden />
      </span>
    </div>
  );
});
