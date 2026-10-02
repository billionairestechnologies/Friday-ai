import { memo, useRef, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy, Download } from "lucide-react";
import { filenameForLang, saveFile } from "@/lib/chat/download";
import { cn } from "@/lib/utils";
import { MermaidBlock } from "@/components/mermaid-block";

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
      className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 text-xs font-medium text-[#9aa0a6] transition-colors duration-150 hover:bg-white/10 hover:text-[#e3e3e3]"
      aria-label={ok ? doneLabel : label}
      onClick={async () => {
        await onPress();
        setOk(true);
        window.setTimeout(() => setOk(false), 2000);
      }}
    >
      {ok ? <Check className="size-3.5 text-emerald-400" /> : <Icon className="size-3.5" />}
      {ok ? doneLabel : null}
    </button>
  );
}

/** Flattens a react-markdown/hast-derived children tree (including rehype-highlight's nested
 *  <span> tokens) back into the plain source text — needed for copy/download since the visible
 *  tree is now a nest of syntax-highlighted spans, not a single string. */
function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (typeof node === "object" && "props" in node) {
    return nodeText((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

/** Gemini-style code block "black box": dark card, header bar with the language tag + copy/
 *  download actions, syntax-highlighted body (via rehype-highlight; token colors are mapped onto
 *  its hljs-* classes in styles.css). Self-contained — the `pre` override below is its only
 *  caller, passing it the already-highlighted <code> element as `children`. */
function CodeBlock({ lang, text, children }: { lang?: string; text: string; children: ReactNode }) {
  return (
    <div className="code-block my-3 overflow-hidden rounded-2xl border border-white/[0.06] bg-[#131314] shadow-[0_4px_20px_rgba(0,0,0,0.25)]">
      <div className="flex items-center justify-between gap-2 border-b border-white/5 bg-[#1e1f20] px-[18px] py-2.5">
        <span className="font-mono text-xs lowercase text-[#9aa0a6]">{lang || "text"}</span>
        <div className="flex items-center gap-1.5">
          <IconAction
            label="Copy code"
            doneLabel="Copied!"
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
      </div>
      <pre className="overflow-x-auto px-5 py-4">{children}</pre>
    </div>
  );
}

/** Fades a markdown image in once it's actually loaded instead of popping in abruptly the
 *  instant `src` resolves — same fade timing as the streamed-text chunks above, for a generated
 *  image (the one place a markdown `![]()` reliably appears in this app today) landing right
 *  after the "Creating your image" indicator disappears. A subtle pulse placeholder fills the
 *  gap while the browser fetches it. */
function FadeInImage({ src, alt }: { src?: string; alt?: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <span className="relative my-2 block overflow-hidden rounded-2xl">
      {!loaded && (
        <span className="absolute inset-0 block animate-pulse rounded-2xl bg-white/5" aria-hidden />
      )}
      <motion.img
        src={src}
        alt={alt ?? ""}
        onLoad={() => setLoaded(true)}
        initial={{ opacity: 0 }}
        animate={{ opacity: loaded ? 1 : 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="block max-w-full rounded-2xl"
      />
    </span>
  );
}

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_HIGHLIGHT = [rehypeHighlight];
const NO_REHYPE: typeof REHYPE_HIGHLIGHT = [];

/**
 * `live` = this is the still-streaming tail of a reply: a half-written mermaid diagram is shown as
 * code (rendering it every frame would throw and flicker), and a very long open code block skips
 * syntax highlighting until it completes (re-highlighting 10KB+ on every frame drops frames).
 */
/**
 * react-markdown drops data: URLs by default — which silently hid real images Friday made itself
 * (browser screenshots, providers that return base64 images). Inline raster images are allowed;
 * everything else (incl. data:image/svg+xml, which can carry script) keeps the default rules.
 */
function urlTransform(url: string, key: string): string {
  if (key === "src" && /^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i.test(url)) return url;
  return defaultUrlTransform(url);
}

export const Markdown = memo(function Markdown({ text, live = false }: { text: string; live?: boolean }) {
  if (!text) return null;
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        urlTransform={urlTransform}
        rehypePlugins={live && text.length > 6000 ? NO_REHYPE : REHYPE_HIGHLIGHT}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          pre: ({ children }) => {
            const codeEl = Array.isArray(children) ? children[0] : children;
            const codeProps =
              codeEl && typeof codeEl === "object" && "props" in codeEl
                ? (codeEl.props as { className?: string; children?: ReactNode })
                : undefined;
            const lang = /language-([a-z0-9+#-]+)/i.exec(codeProps?.className ?? "")?.[1];
            const value = nodeText(codeProps?.children).replace(/\n$/, "");
            const block = (
              <CodeBlock lang={lang} text={value}>
                {children}
              </CodeBlock>
            );
            return lang === "mermaid" && !live ? <MermaidBlock text={value} fallback={block} /> : block;
          },
          code: ({ className, children, node: _node, ...props }) => (
            <code className={className} {...props}>
              {children}
            </code>
          ),
          table: ({ children }) => (
            <div className="my-3 min-h-[3rem] overflow-x-auto">
              <table>{children}</table>
            </div>
          ),
          img: ({ src, alt }) => <FadeInImage src={typeof src === "string" ? src : undefined} alt={alt} />,
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
  // Every completed block (a whole paragraph, table, list, code block — whatever
  // splitStreamingMarkdown's `\n\n`/fence boundary just closed off) is pushed here once and rendered
  // as its OWN memoized Markdown instance, so finished blocks are never re-parsed while the reply
  // keeps streaming — only the short in-progress tail is.
  const chunksRef = useRef<string[]>([]);

  if (streaming) {
    const { stable } = splitStreamingMarkdown(text);
    if (stable.length > committedRef.current.length && stable.startsWith(committedRef.current)) {
      chunksRef.current = [...chunksRef.current, stable.slice(committedRef.current.length)];
      committedRef.current = stable;
    } else if (!text.startsWith(committedRef.current)) {
      // Defensive fallback for the rare case text didn't purely grow from what we'd committed.
      chunksRef.current = stable ? [stable] : [];
      committedRef.current = stable;
    }
  } else if (!committedRef.current || !text.startsWith(committedRef.current)) {
    // A message loaded from history (never streamed in this component): one plain render.
    committedRef.current = "";
    chunksRef.current = [];
    return (
      <div className="relative min-h-[1.65em] w-full">
        <Markdown text={text} />
      </div>
    );
  }

  // The tail renders as real markdown too. It used to be plain word spans that were swapped for
  // formatted markdown (and faded in again from invisible) the moment a paragraph completed — text
  // the user was already reading blinked out, reflowed and slid back in once per paragraph, the
  // main "glitchy" feel of streaming. Now nothing already on screen ever re-animates or remounts:
  // a finished reply keeps this exact tree (same keys), so the end of a stream is seamless too.
  const rest = text.slice(committedRef.current.length);
  return (
    <div className={cn("relative min-h-[1.65em] w-full [overflow-anchor:none]", streaming && "stream-live")}>
      {chunksRef.current.map((chunk, i) => (
        <Markdown key={i} text={chunk} />
      ))}
      {rest ? <Markdown key="tail" text={rest} live={streaming} /> : null}
      {streaming && !rest && <span className="stream-caret" aria-hidden />}
    </div>
  );
});
