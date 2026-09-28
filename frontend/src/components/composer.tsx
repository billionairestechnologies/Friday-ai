import { PromptInputBox } from "@/components/ui/ai-prompt-box";
import { useChat } from "@/lib/chat/store";

type ComposerProps = {
  onSend: (text: string, files?: File[]) => void;
  onStop: () => void;
  streaming: boolean;
  disabled?: boolean;
};

export function Composer({
  onSend,
  onStop,
  streaming,
  disabled,
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

  return (
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
      placeholder="What do you want to know?"
    />
  );
}
