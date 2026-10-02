import { useEffect, useRef } from "react";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extensions";
import { Bold, Code, Heading1, Heading2, Heading3, Italic, List, ListOrdered, Minus, Quote, Redo2, Strikethrough, Table2, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The document editor: rich text (TipTap) stored as Markdown — the same text Friday's read_page /
 * update_page tools see and edit, and what the .docx/.pdf/.md export renders. `markdown` changes
 * from outside (Friday's edit, a restore) replace the content; the user's own typing doesn't
 * round-trip through that path, so the cursor never jumps.
 */
export function DocEditor({ markdown, onChange, readOnly = false }: { markdown: string; onChange?: (md: string) => void; readOnly?: boolean }) {
  const lastEmitted = useRef(markdown);
  const editor = useEditor({
    extensions: [StarterKit.configure({ link: { openOnClick: readOnly } }), Markdown, TableKit.configure({ table: { resizable: false } }), Placeholder.configure({ placeholder: "Start writing, or ask Friday to draft this page…" })],
    content: markdown,
    contentType: "markdown",
    editable: !readOnly,
    immediatelyRender: false,
    editorProps: { attributes: { class: "md friday-doc min-h-[60vh] focus:outline-none" } },
    onUpdate: ({ editor }) => {
      const md = editor.getMarkdown();
      lastEmitted.current = md;
      onChange?.(md);
    },
  });

  useEffect(() => {
    if (!editor || markdown === lastEmitted.current) return;
    lastEmitted.current = markdown;
    editor.commands.setContent(markdown, { contentType: "markdown", emitUpdate: false });
  }, [editor, markdown]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!readOnly && editor && <Toolbar editor={editor} />}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-5 py-8 md:px-10">
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      h1: e.isActive("heading", { level: 1 }),
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      ul: e.isActive("bulletList"),
      ol: e.isActive("orderedList"),
      quote: e.isActive("blockquote"),
      table: e.isActive("table"),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const c = () => editor.chain().focus();
  const items: { icon: typeof Bold; label: string; on?: boolean; run: () => void; disabled?: boolean; gap?: boolean }[] = [
    { icon: Undo2, label: "Undo", run: () => c().undo().run(), disabled: !s.canUndo },
    { icon: Redo2, label: "Redo", run: () => c().redo().run(), disabled: !s.canRedo },
    { icon: Heading1, label: "Heading 1", on: s.h1, run: () => c().toggleHeading({ level: 1 }).run(), gap: true },
    { icon: Heading2, label: "Heading 2", on: s.h2, run: () => c().toggleHeading({ level: 2 }).run() },
    { icon: Heading3, label: "Heading 3", on: s.h3, run: () => c().toggleHeading({ level: 3 }).run() },
    { icon: Bold, label: "Bold", on: s.bold, run: () => c().toggleBold().run(), gap: true },
    { icon: Italic, label: "Italic", on: s.italic, run: () => c().toggleItalic().run() },
    { icon: Strikethrough, label: "Strikethrough", on: s.strike, run: () => c().toggleStrike().run() },
    { icon: Code, label: "Code", on: s.code, run: () => c().toggleCode().run() },
    { icon: List, label: "Bullet list", on: s.ul, run: () => c().toggleBulletList().run(), gap: true },
    { icon: ListOrdered, label: "Numbered list", on: s.ol, run: () => c().toggleOrderedList().run() },
    { icon: Quote, label: "Quote", on: s.quote, run: () => c().toggleBlockquote().run() },
    { icon: Minus, label: "Divider", run: () => c().setHorizontalRule().run() },
    { icon: Table2, label: "Insert table", on: s.table, run: () => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  ];
  return (
    <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-3 py-1.5" role="toolbar" aria-label="Formatting">
      {items.map((it) => (
        <span key={it.label} className="flex items-center">
          {it.gap && <span className="mx-1 h-5 w-px bg-border" />}
          <button
            type="button"
            title={it.label}
            aria-label={it.label}
            aria-pressed={it.on}
            disabled={it.disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={it.run}
            className={cn("flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-chip hover:text-foreground disabled:opacity-35", it.on && "bg-chip-on text-foreground")}
          >
            <it.icon className="size-4" />
          </button>
        </span>
      ))}
      {s.table && (
        <span className="ml-2 flex items-center gap-1 text-xs">
          {[
            ["+ Row", () => c().addRowAfter().run()],
            ["+ Column", () => c().addColumnAfter().run()],
            ["− Row", () => c().deleteRow().run()],
            ["− Column", () => c().deleteColumn().run()],
            ["Delete table", () => c().deleteTable().run()],
          ].map(([label, run]) => (
            <button key={label as string} type="button" onMouseDown={(e) => e.preventDefault()} onClick={run as () => void} className="h-7 rounded-lg px-2 whitespace-nowrap text-muted hover:bg-chip hover:text-foreground">
              {label as string}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}
