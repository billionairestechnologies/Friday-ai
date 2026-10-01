import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { PromptInputBox } from "@/components/ui/ai-prompt-box";
import { useChat } from "@/lib/chat/store";

type ComposerProps = {
  onSend: (text: string, files?: File[]) => void;
  onStop: () => void;
  streaming: boolean;
  disabled?: boolean;
  /** Overrides the default prompt text, e.g. while a Build plan waits for feedback. */
  placeholder?: string;
  /** Build workspace: no voice-agent mode (mic dictation still works). */
  hideVoiceMode?: boolean;
};

export function Composer({
  onSend,
  onStop,
  streaming,
  disabled,
  placeholder,
  hideVoiceMode,
}: ComposerProps) {
  const think = useChat((s) => s.think);
  const setThink = useChat((s) => s.setThink);
  const webSearch = useChat((s) => s.webSearch);
  const setWebSearch = useChat((s) => s.setWebSearch);
  const canvas = useChat((s) => s.canvas);
  const setCanvas = useChat((s) => s.setCanvas);
  const research = useChat((s) => s.research);
  const setResearch = useChat((s) => s.setResearch);
  const model = useChat((s) => s.model);
  const setModel = useChat((s) => s.setModel);
  const activeSkill = useChat((s) => s.activeSkill);
  const setActiveSkill = useChat((s) => s.setActiveSkill);

  return (
    <>
    <AnimatePresence>
      {activeSkill && (
        <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} className="mb-2 flex">
          <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-canvas/40 bg-canvas/10 pr-1 pl-3 text-xs font-medium text-foreground">
            <span aria-hidden>{activeSkill.icon}</span>
            <span className="text-muted">Skill:</span> {activeSkill.name}
            <button type="button" onClick={() => setActiveSkill(null)} aria-label="Stop using this skill" className="ml-0.5 flex size-6 items-center justify-center rounded-full text-muted hover:bg-chip hover:text-foreground">
              <X className="size-3.5" />
            </button>
          </span>
        </motion.div>
      )}
    </AnimatePresence>
    <PromptInputBox
      isLoading={streaming}
      disabled={disabled}
      think={think}
      search={webSearch}
      canvas={canvas}
      research={research}
      onThinkChange={setThink}
      onSearchChange={setWebSearch}
      onCanvasChange={setCanvas}
      onResearchChange={setResearch}
      model={model}
      onModelChange={setModel}
      onStop={onStop}
      onSend={onSend}
      hideVoiceMode={hideVoiceMode}
      placeholder={placeholder ?? "What do you want to know?"}
    />
    </>
  );
}
