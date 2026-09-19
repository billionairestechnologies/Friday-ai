import React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ArrowUp,
  Camera,
  FileText,
  Image as ImageIcon,
  Paperclip,
  Square,
  X,
  StopCircle,
  Mic,
  Globe,
  BrainCog,
  FolderCode,
  Check,
  ChevronDown,
  Lock,
  Zap,
  Users,
  AudioLines,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { AUTO_MODEL_ID, TEAMUP_MODEL_ID, getModel, useModels } from "@/lib/chat/models";
import { planSatisfiesTier, usePlan } from "@/lib/usage/planStore";
import { ProviderLogo } from "@/components/provider-logos";
import { createLiveAnalyser, type LiveAnalyser } from "@/lib/audio/analyser";
import { VoiceMode } from "@/components/voice-mode";
import { api } from "@/lib/api";

function ModelIcon({ id, providerSlug, className }: { id: string; providerSlug?: string; className?: string }) {
  if (id === AUTO_MODEL_ID) return <Zap className={className} aria-hidden />;
  if (id === TEAMUP_MODEL_ID) return <Users className={className} aria-hidden />;
  return <ProviderLogo slug={providerSlug} className={className} />;
}

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    className={cn(
      "flex min-h-11 w-full resize-none rounded-md border-none bg-transparent px-3 py-2.5 text-base text-foreground placeholder:text-subtle focus-visible:ring-0 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    ref={ref}
    rows={1}
    {...props}
  />
));
Textarea.displayName = "Textarea";

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;
const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Content
    ref={ref}
    sideOffset={sideOffset}
    className={cn(
      "z-50 overflow-hidden rounded-md border border-border bg-elevated px-3 py-1.5 text-sm text-foreground shadow-md",
      className,
    )}
    {...props}
  />
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

const Dialog = DialogPrimitive.Root;
const DialogPortal = DialogPrimitive.Portal;
const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed top-[50%] left-[50%] z-50 grid w-full max-w-[90vw] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-2xl border border-border bg-elevated p-0 shadow-xl duration-300 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 md:max-w-[800px]",
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute top-4 right-4 z-10 rounded-full bg-chip/80 p-2 transition-all hover:bg-chip">
        <X className="h-5 w-5 text-muted hover:text-foreground" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg leading-none font-semibold tracking-tight text-foreground",
      className,
    )}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "outline" | "ghost";
  size?: "default" | "sm" | "lg" | "icon";
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", ...props }, ref) => {
    const variantClasses = {
      default: "bg-primary text-primary-foreground hover:opacity-90",
      outline: "border border-border bg-transparent hover:bg-chip",
      ghost: "bg-transparent hover:bg-chip",
    };
    const sizeClasses = {
      default: "h-10 px-4 py-2",
      sm: "h-8 px-3 text-sm",
      lg: "h-12 px-6",
      icon: "h-8 w-8 rounded-full aspect-square",
    };
    return (
      <button
        className={cn(
          "inline-flex items-center justify-center font-medium transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
          variantClasses[variant],
          sizeClasses[size],
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

function VoiceRecorder({
  isRecording,
  analyser,
  onCancel,
  onConfirm,
  visualizerBars = 32,
}: {
  isRecording: boolean;
  analyser: LiveAnalyser | null;
  onCancel: () => void;
  onConfirm: () => void;
  visualizerBars?: number;
}) {
  const [time, setTime] = React.useState(0);
  const barRefs = React.useRef<(HTMLDivElement | null)[]>([]);

  React.useEffect(() => {
    if (!isRecording) {
      setTime((t) => (t === 0 ? t : 0));
      return;
    }
    const id = window.setInterval(() => setTime((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [isRecording]);

  // Imperative rAF loop so live audio levels don't force a React re-render every frame.
  React.useEffect(() => {
    if (!isRecording || !analyser) return;
    let raf = 0;
    const tick = () => {
      const data = analyser.getFrequencyData();
      const step = Math.max(1, Math.floor(data.length / visualizerBars));
      for (let i = 0; i < visualizerBars; i++) {
        const v = data[i * step] ?? 0;
        const pct = 12 + (v / 255) * 88;
        const bar = barRefs.current[i];
        if (bar) bar.style.height = `${pct}%`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isRecording, analyser, visualizerBars]);

  const mins = Math.floor(time / 60)
    .toString()
    .padStart(2, "0");
  const secs = (time % 60).toString().padStart(2, "0");

  return (
    <div
      className={cn(
        "flex w-full items-center gap-3 py-2 transition-all duration-300",
        isRecording ? "opacity-100" : "h-0 opacity-0",
      )}
    >
      <button
        type="button"
        onClick={onCancel}
        aria-label="Cancel recording"
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-chip hover:text-foreground"
      >
        <X className="size-4" />
      </button>
      <div className="flex h-2 w-2 shrink-0 items-center justify-center">
        <div className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
      </div>
      <span className="shrink-0 font-mono text-xs text-foreground/80">
        {mins}:{secs}
      </span>
      <div className="flex h-9 min-w-0 flex-1 items-center justify-center gap-0.5">
        {Array.from({ length: visualizerBars }).map((_, i) => (
          <div
            key={i}
            ref={(el) => {
              barRefs.current[i] = el;
            }}
            className="w-0.5 shrink-0 rounded-full bg-foreground/60 transition-[height] duration-75"
            style={{ height: "12%" }}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={onConfirm}
        aria-label="Confirm recording"
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90"
      >
        <Check className="size-4" />
      </button>
    </div>
  );
}

function ImageViewDialog({
  imageUrl,
  onClose,
}: {
  imageUrl: string | null;
  onClose: () => void;
}) {
  if (!imageUrl) return null;
  return (
    <Dialog
      open={!!imageUrl}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-[90vw] border-none bg-transparent p-0 shadow-none md:max-w-[800px]">
        <DialogTitle className="sr-only">Image Preview</DialogTitle>
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="relative overflow-hidden rounded-2xl bg-elevated shadow-2xl"
        >
          <img
            src={imageUrl}
            alt="Full preview"
            className="max-h-[80vh] w-full rounded-2xl object-contain"
          />
        </motion.div>
      </DialogContent>
    </Dialog>
  );
}

interface PromptInputContextType {
  isLoading: boolean;
  value: string;
  setValue: (value: string) => void;
  maxHeight: number | string;
  onSubmit?: () => void;
  disabled?: boolean;
}

const PromptInputContext = React.createContext<PromptInputContextType>({
  isLoading: false,
  value: "",
  setValue: () => {},
  maxHeight: 240,
  onSubmit: undefined,
  disabled: false,
});

function usePromptInput() {
  return React.useContext(PromptInputContext);
}

interface PromptInputProps {
  isLoading?: boolean;
  value?: string;
  onValueChange?: (value: string) => void;
  maxHeight?: number | string;
  onSubmit?: () => void;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
}

const PromptInput = React.forwardRef<HTMLDivElement, PromptInputProps>(
  (
    {
      className,
      isLoading = false,
      maxHeight = 240,
      value,
      onValueChange,
      onSubmit,
      children,
      disabled = false,
      onDragOver,
      onDragLeave,
      onDrop,
    },
    ref,
  ) => {
    const [internalValue, setInternalValue] = React.useState(value || "");
    const handleChange = (newValue: string) => {
      setInternalValue(newValue);
      onValueChange?.(newValue);
    };
    return (
      <TooltipProvider delayDuration={200}>
        <PromptInputContext.Provider
          value={{
            isLoading,
            value: value ?? internalValue,
            setValue: onValueChange ?? handleChange,
            maxHeight,
            onSubmit,
            disabled,
          }}
        >
          <div
            ref={ref}
            className={cn(
              "m3-focus-halo rounded-2xl border border-border bg-composer p-2 shadow-[var(--shadow-composer)]",
              isLoading && "border border-red-500/70",
              className,
            )}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            {children}
          </div>
        </PromptInputContext.Provider>
      </TooltipProvider>
    );
  },
);
PromptInput.displayName = "PromptInput";

const PromptInputTextarea: React.FC<
  { disableAutosize?: boolean; placeholder?: string } & React.ComponentProps<
    typeof Textarea
  >
> = ({ className, onKeyDown, disableAutosize = false, placeholder, ...props }) => {
  const { value, setValue, maxHeight, onSubmit, disabled } = usePromptInput();
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  React.useLayoutEffect(() => {
    const el = textareaRef.current;
    if (disableAutosize || !el) return;
    const max =
      typeof maxHeight === "number"
        ? maxHeight
        : Number.parseInt(String(maxHeight), 10) || 240;
    el.style.height = "44px";
    const next = Math.max(44, Math.min(el.scrollHeight, max));
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [value, maxHeight, disableAutosize]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSubmit?.();
    }
    onKeyDown?.(e);
  };

  return (
    <Textarea
      ref={textareaRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={handleKeyDown}
      className={cn("overflow-hidden text-base", className)}
      disabled={disabled}
      placeholder={placeholder}
      {...props}
    />
  );
};

const PromptInputActions: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  children,
  className,
  ...props
}) => (
  <div className={cn("flex items-center gap-2", className)} {...props}>
    {children}
  </div>
);

const PromptInputAction: React.FC<{
  tooltip: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  side?: "top" | "bottom" | "left" | "right";
}> = ({ tooltip, children, className, side = "top" }) => {
  const { disabled } = usePromptInput();
  return (
    <Tooltip>
      <TooltipTrigger asChild disabled={disabled}>
        {children}
      </TooltipTrigger>
      <TooltipContent side={side} className={className}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
};

const CustomDivider: React.FC = () => (
  <div className="relative mx-1 h-6 w-[1.5px] shrink-0">
    <div
      className="absolute inset-0 rounded-full bg-gradient-to-t from-transparent via-[#9b87f5]/70 to-transparent"
      style={{
        clipPath:
          "polygon(0% 0%, 100% 0%, 100% 40%, 140% 50%, 100% 60%, 100% 100%, 0% 100%, 0% 60%, -40% 50%, 0% 40%)",
      }}
    />
  </div>
);

export interface PromptInputBoxProps {
  onSend?: (message: string, files?: File[]) => void;
  onStop?: () => void;
  isLoading?: boolean;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  think?: boolean;
  search?: boolean;
  onThinkChange?: (value: boolean) => void;
  onSearchChange?: (value: boolean) => void;
  canvas?: boolean;
  onCanvasChange?: (value: boolean) => void;
  model?: string;
  onModelChange?: (id: string) => void;
}

export const PromptInputBox = React.forwardRef<HTMLDivElement, PromptInputBoxProps>(
  (props, ref) => {
    const {
      onSend = () => {},
      onStop,
      isLoading = false,
      placeholder = "Type your message here...",
      className,
      disabled = false,
      think,
      search,
      onThinkChange,
      onSearchChange,
      canvas,
      onCanvasChange,
      model,
      onModelChange,
    } = props;
    const [input, setInput] = React.useState("");
    const [files, setFiles] = React.useState<File[]>([]);
    const [filePreviews, setFilePreviews] = React.useState<Record<string, string>>(
      {},
    );
    const [selectedImage, setSelectedImage] = React.useState<string | null>(null);
    const [attachError, setAttachError] = React.useState<string | null>(null);
    const [isRecording, setIsRecording] = React.useState(false);
    const [isTranscribing, setIsTranscribing] = React.useState(false);
    const [recordError, setRecordError] = React.useState<string | null>(null);
    const [liveAnalyser, setLiveAnalyser] = React.useState<LiveAnalyser | null>(null);
    const [voiceModeOpen, setVoiceModeOpen] = React.useState(false);
    const [internalSearch, setInternalSearch] = React.useState(false);
    const [internalThink, setInternalThink] = React.useState(false);
    const [internalCanvas, setInternalCanvas] = React.useState(false);
    const photoVideoInputRef = React.useRef<HTMLInputElement>(null);
    const documentInputRef = React.useRef<HTMLInputElement>(null);
    const cameraInputRef = React.useRef<HTMLInputElement>(null);
    const promptBoxRef = React.useRef<HTMLDivElement>(null);
    const mediaRecorderRef = React.useRef<MediaRecorder | null>(null);
    const chunksRef = React.useRef<Blob[]>([]);
    const cancelledRef = React.useRef(false);
    const analyserRef = React.useRef<LiveAnalyser | null>(null);
    const models = useModels((s) => s.models);
    const navigate = useNavigate();
    const viewerPlan = usePlan((s) => s.plan);
    const isEnterprise = usePlan((s) => s.isEnterprise);
    const loadPlan = usePlan((s) => s.load);

    React.useEffect(() => {
      void loadPlan();
    }, [loadPlan]);

    React.useEffect(() => {
      if (!recordError) return;
      const id = window.setTimeout(() => setRecordError(null), 4000);
      return () => window.clearTimeout(id);
    }, [recordError]);

    async function startRecording() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        chunksRef.current = [];
        cancelledRef.current = false;
        const analyser = createLiveAnalyser(stream);
        analyserRef.current = analyser;
        setLiveAnalyser(analyser);
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop());
          analyserRef.current?.close();
          analyserRef.current = null;
          setLiveAnalyser(null);
          setIsRecording(false);
          if (cancelledRef.current) return;
          const blob = new Blob(chunksRef.current, { type: "audio/webm" });
          setIsTranscribing(true);
          try {
            const form = new FormData();
            form.append("audio", blob, "recording.webm");
            const res = await api.post<{ text: string }>("/voice/transcribe", form);
            setInput((prev) => (prev ? `${prev} ${res.text}` : res.text));
          } catch (err) {
            setRecordError(err instanceof Error ? err.message : "Couldn't transcribe that recording");
          } finally {
            setIsTranscribing(false);
          }
        };
        mediaRecorderRef.current = recorder;
        recorder.start();
        setIsRecording(true);
      } catch {
        setIsRecording(false);
        setRecordError("Couldn't access the microphone");
      }
    }

    function stopRecording() {
      cancelledRef.current = false;
      mediaRecorderRef.current?.stop();
    }

    function cancelRecording() {
      cancelledRef.current = true;
      mediaRecorderRef.current?.stop();
    }

    // Push-to-talk: hold Space anywhere on the page (when not typing, and not on a focused
    // button, where Space already means "click") to dictate, release to transcribe it in.
    React.useEffect(() => {
      function isTypingOrActivatable(el: Element | null) {
        if (!(el instanceof HTMLElement)) return false;
        return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "BUTTON" || el.isContentEditable;
      }
      function onKeyDown(e: KeyboardEvent) {
        if (e.code !== "Space" || e.repeat) return;
        if (isTypingOrActivatable(document.activeElement)) return;
        if (disabled || isRecording || isTranscribing || voiceModeOpen) return;
        e.preventDefault();
        void startRecording();
      }
      function onKeyUp(e: KeyboardEvent) {
        if (e.code !== "Space" || !isRecording) return;
        e.preventDefault();
        stopRecording();
      }
      window.addEventListener("keydown", onKeyDown);
      window.addEventListener("keyup", onKeyUp);
      return () => {
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("keyup", onKeyUp);
      };
    }, [disabled, isRecording, isTranscribing, voiceModeOpen]);

    const showSearch = search ?? internalSearch;
    const showThink = think ?? internalThink;
    const showCanvas = canvas ?? internalCanvas;

    const setSearch = (v: boolean) => {
      setInternalSearch(v);
      onSearchChange?.(v);
    };
    const setThink = (v: boolean) => {
      setInternalThink(v);
      onThinkChange?.(v);
    };
    const setCanvas = (v: boolean) => {
      setInternalCanvas(v);
      onCanvasChange?.(v);
    };

    const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
    const isImageFile = (file: File) => file.type.startsWith("image/");
    const isVideoFile = (file: File) => file.type.startsWith("video/");
    const isPreviewableFile = (file: File) => isImageFile(file) || isVideoFile(file);

    const processFile = (file: File) => {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setAttachError(`${file.name} is larger than 10 MB`);
        window.setTimeout(() => setAttachError(null), 3000);
        return;
      }
      setAttachError(null);
      setFiles([file]);
      if (!isPreviewableFile(file)) {
        setFilePreviews({});
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) =>
        setFilePreviews({ [file.name]: String(e.target?.result ?? "") });
      reader.readAsDataURL(file);
    };

    const handleDragOver = React.useCallback((e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    }, []);

    const handleDragLeave = React.useCallback((e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    }, []);

    const handleDrop = React.useCallback((e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const dropped = e.dataTransfer.files[0];
      if (dropped) processFile(dropped);
    }, []);

    const handleRemoveFile = () => {
      setFilePreviews({});
      setFiles([]);
    };

    React.useEffect(() => {
      const handlePaste = (e: ClipboardEvent) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item && item.type.indexOf("image") !== -1) {
            const file = item.getAsFile();
            if (file) {
              e.preventDefault();
              processFile(file);
              break;
            }
          }
        }
      };
      document.addEventListener("paste", handlePaste);
      return () => document.removeEventListener("paste", handlePaste);
    }, []);

    const handleSubmit = () => {
      if (input.trim() || files.length > 0) {
        onSend(input, files);
        setInput("");
        setFiles([]);
        setFilePreviews({});
      }
    };

    const hasContent = input.trim() !== "" || files.length > 0;
    const currentModel = model ? getModel(models, model) : null;

    function submitVoiceText(text: string) {
      if (text.trim()) onSend(text.trim(), []);
    }

    return (
      <>
        <PromptInput
          value={input}
          onValueChange={setInput}
          isLoading={isLoading}
          onSubmit={handleSubmit}
          className={cn(
            "w-full border-border bg-composer shadow-[var(--shadow-composer)] transition-[border-color] duration-200",
            isRecording && "border-red-500/70",
            className,
          )}
          disabled={disabled || isLoading || isRecording}
          ref={ref || promptBoxRef}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {files.length > 0 && !isRecording && (
            <div className="flex flex-wrap gap-2 p-0 pb-1 transition-all duration-300">
              {files.map((file) =>
                filePreviews[file.name] && isImageFile(file) ? (
                  <div key={file.name} className="group relative">
                    <div
                      className="h-16 w-16 cursor-pointer overflow-hidden rounded-xl transition-all duration-300"
                      onClick={() => setSelectedImage(filePreviews[file.name] ?? null)}
                    >
                      <img
                        src={filePreviews[file.name]}
                        alt={file.name}
                        className="h-full w-full object-cover"
                      />
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveFile();
                        }}
                        className="absolute top-1 right-1 rounded-full bg-black/70 p-0.5 opacity-100 transition-opacity"
                      >
                        <X className="h-3 w-3 text-white" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div
                    key={file.name}
                    className="flex items-center gap-1.5 rounded-xl bg-chip py-1.5 pr-1.5 pl-2.5 text-xs text-foreground"
                  >
                    {isVideoFile(file) ? (
                      <ImageIcon className="size-3.5 text-muted" />
                    ) : (
                      <FileText className="size-3.5 text-muted" />
                    )}
                    <span className="max-w-40 truncate">{file.name}</span>
                    <button
                      type="button"
                      onClick={handleRemoveFile}
                      className="flex size-5 items-center justify-center rounded-full text-muted hover:bg-elevated hover:text-foreground"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ),
              )}
            </div>
          )}
          {attachError && <p className="px-1 pb-1 text-xs text-danger">{attachError}</p>}
          {recordError && <p className="px-1 pb-1 text-xs text-danger">{recordError}</p>}

          <div
            className={cn(
              "transition-all duration-300",
              isRecording ? "h-0 overflow-hidden opacity-0" : "opacity-100",
            )}
          >
            <PromptInputTextarea
              placeholder={
                showSearch
                  ? "Search the web..."
                  : showThink
                    ? "Think deeply..."
                    : showCanvas
                      ? "Create on canvas..."
                      : placeholder
              }
              className="text-base"
            />
          </div>

          {isRecording && (
            <VoiceRecorder
              isRecording={isRecording}
              analyser={liveAnalyser}
              onCancel={cancelRecording}
              onConfirm={stopRecording}
            />
          )}

          <PromptInputActions className="flex items-center justify-between gap-2 p-0 pt-2">
            <div
              className={cn(
                "flex min-w-0 items-center gap-1 overflow-x-auto transition-opacity duration-300",
                isRecording ? "invisible h-0 opacity-0" : "visible opacity-100",
              )}
            >
              <DropdownMenu.Root>
                <PromptInputAction tooltip="Attach a file">
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted transition-colors hover:bg-chip hover:text-foreground"
                      disabled={isRecording}
                    >
                      <Paperclip className="h-5 w-5 transition-colors" />
                    </button>
                  </DropdownMenu.Trigger>
                </PromptInputAction>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    align="start"
                    sideOffset={8}
                    className="z-50 min-w-48 rounded-xl border border-border bg-elevated p-1 shadow-xl"
                  >
                    <DropdownMenu.Item
                      onSelect={() => photoVideoInputRef.current?.click()}
                      className="flex cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-sm text-foreground outline-none data-[highlighted]:bg-chip"
                    >
                      <ImageIcon className="size-4 text-muted" />
                      Photos
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      onSelect={() => documentInputRef.current?.click()}
                      className="flex cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-sm text-foreground outline-none data-[highlighted]:bg-chip"
                    >
                      <FileText className="size-4 text-muted" />
                      Documents
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      onSelect={() => cameraInputRef.current?.click()}
                      className="flex cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-sm text-foreground outline-none data-[highlighted]:bg-chip"
                    >
                      <Camera className="size-4 text-muted" />
                      Camera
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
              <input
                ref={photoVideoInputRef}
                type="file"
                className="hidden"
                accept="image/*"
                onChange={(e) => {
                  if (e.target.files?.[0]) processFile(e.target.files[0]);
                  if (e.target) e.target.value = "";
                }}
              />
              <input
                ref={documentInputRef}
                type="file"
                className="hidden"
                // PDF/DOCX/XLSX are the document types the backend actually processes (PDF via
                // Sarvam's Doc AI OCR, DOCX/XLSX parsed directly) — anything else here would look
                // attached in the UI but silently vanish before the request went out.
                accept=".pdf,.docx,.xlsx"
                onChange={(e) => {
                  if (e.target.files?.[0]) processFile(e.target.files[0]);
                  if (e.target) e.target.value = "";
                }}
              />
              <input
                ref={cameraInputRef}
                type="file"
                className="hidden"
                accept="image/*"
                capture="environment"
                onChange={(e) => {
                  if (e.target.files?.[0]) processFile(e.target.files[0]);
                  if (e.target) e.target.value = "";
                }}
              />

              <div className="flex items-center">
                <button
                  type="button"
                  onClick={() => setSearch(!showSearch)}
                  className={cn(
                    "m3-chip flex h-8 shrink-0 items-center gap-1 rounded-full border-[1.5px] px-2 py-1",
                    showSearch
                      ? "border-search bg-search/15 text-search"
                      : "border-transparent bg-transparent text-muted hover:text-foreground",
                  )}
                >
                  <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
                    <motion.div
                      animate={{
                        rotate: showSearch ? 360 : 0,
                        scale: showSearch ? 1.1 : 1,
                      }}
                      whileHover={{
                        rotate: showSearch ? 360 : 15,
                        scale: 1.1,
                        transition: { type: "spring", stiffness: 300, damping: 10 },
                      }}
                      transition={{ type: "spring", stiffness: 260, damping: 25 }}
                    >
                      <Globe
                        className={cn(
                          "h-4 w-4",
                          showSearch ? "text-search" : "text-inherit",
                        )}
                      />
                    </motion.div>
                  </div>
                  <AnimatePresence>
                    {showSearch && (
                      <motion.span
                        initial={{ width: 0, opacity: 0 }}
                        animate={{ width: "auto", opacity: 1 }}
                        exit={{ width: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="flex-shrink-0 overflow-hidden text-xs whitespace-nowrap text-search"
                      >
                        Search
                      </motion.span>
                    )}
                  </AnimatePresence>
                </button>

                <CustomDivider />

                <button
                  type="button"
                  onClick={() => setThink(!showThink)}
                  className={cn(
                    "m3-chip flex h-8 shrink-0 items-center gap-1 rounded-full border-[1.5px] px-2 py-1",
                    showThink
                      ? "border-think bg-think/15 text-think"
                      : "border-transparent bg-transparent text-muted hover:text-foreground",
                  )}
                >
                  <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
                    <motion.div
                      animate={{
                        rotate: showThink ? 360 : 0,
                        scale: showThink ? 1.1 : 1,
                      }}
                      whileHover={{
                        rotate: showThink ? 360 : 15,
                        scale: 1.1,
                        transition: { type: "spring", stiffness: 300, damping: 10 },
                      }}
                      transition={{ type: "spring", stiffness: 260, damping: 25 }}
                    >
                      <BrainCog
                        className={cn(
                          "h-4 w-4",
                          showThink ? "text-think" : "text-inherit",
                        )}
                      />
                    </motion.div>
                  </div>
                  <AnimatePresence>
                    {showThink && (
                      <motion.span
                        initial={{ width: 0, opacity: 0 }}
                        animate={{ width: "auto", opacity: 1 }}
                        exit={{ width: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="flex-shrink-0 overflow-hidden text-xs whitespace-nowrap text-think"
                      >
                        Think
                      </motion.span>
                    )}
                  </AnimatePresence>
                </button>

                <CustomDivider />

                <button
                  type="button"
                  onClick={() => setCanvas(!showCanvas)}
                  className={cn(
                    "m3-chip flex h-8 shrink-0 items-center gap-1 rounded-full border-[1.5px] px-2 py-1",
                    showCanvas
                      ? "border-canvas bg-canvas/15 text-canvas"
                      : "border-transparent bg-transparent text-muted hover:text-foreground",
                  )}
                >
                  <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
                    <motion.div
                      animate={{
                        rotate: showCanvas ? 360 : 0,
                        scale: showCanvas ? 1.1 : 1,
                      }}
                      whileHover={{
                        rotate: showCanvas ? 360 : 15,
                        scale: 1.1,
                        transition: { type: "spring", stiffness: 300, damping: 10 },
                      }}
                      transition={{ type: "spring", stiffness: 260, damping: 25 }}
                    >
                      <FolderCode
                        className={cn(
                          "h-4 w-4",
                          showCanvas ? "text-canvas" : "text-inherit",
                        )}
                      />
                    </motion.div>
                  </div>
                  <AnimatePresence>
                    {showCanvas && (
                      <motion.span
                        initial={{ width: 0, opacity: 0 }}
                        animate={{ width: "auto", opacity: 1 }}
                        exit={{ width: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="flex-shrink-0 overflow-hidden text-xs whitespace-nowrap text-canvas"
                      >
                        Canvas
                      </motion.span>
                    )}
                  </AnimatePresence>
                </button>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <PromptInputAction tooltip="Voice mode">
                <button
                  type="button"
                  onClick={() => setVoiceModeOpen(true)}
                  disabled={disabled}
                  aria-label="Open voice mode"
                  className="flex size-8 items-center justify-center rounded-full text-muted transition-colors hover:bg-chip hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                >
                  <AudioLines className="h-4 w-4" />
                </button>
              </PromptInputAction>

              {currentModel && onModelChange && (
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap text-muted transition-colors hover:bg-chip hover:text-foreground"
                    >
                      <ModelIcon id={currentModel.id} providerSlug={currentModel.providerSlug} className="size-3.5 shrink-0" />
                      <span>{currentModel.short}</span>
                      <ChevronDown className="size-3 shrink-0 opacity-70" />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      align="end"
                      sideOffset={8}
                      className="z-50 min-w-56 rounded-xl border border-border bg-elevated p-1 shadow-xl"
                    >
                      {models.map((m) => {
                        const locked = !planSatisfiesTier(viewerPlan, isEnterprise, m.minTier);
                        return (
                          <DropdownMenu.Item
                            key={m.id}
                            onSelect={() => {
                              if (locked) {
                                void navigate({ to: "/upgrade" });
                                return;
                              }
                              onModelChange(m.id);
                            }}
                            className={cn(
                              "flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-sm outline-none data-[highlighted]:bg-chip",
                              locked ? "text-muted" : "text-foreground",
                            )}
                          >
                            <span className="flex min-w-0 items-center gap-2.5">
                              <ModelIcon id={m.id} providerSlug={m.providerSlug} className={cn("size-4 shrink-0", locked && "opacity-50")} />
                              <span className="min-w-0">
                                <span className="block font-medium">{m.label}</span>
                                {locked ? (
                                  <span className="block text-xs text-muted">
                                    {m.minTier === "premium" ? "Premium" : "Pro"} — upgrade to unlock
                                  </span>
                                ) : (
                                  m.hint !== m.label && <span className="block text-xs text-muted">{m.hint}</span>
                                )}
                              </span>
                            </span>
                            {locked ? (
                              <Lock className="size-3.5 shrink-0 text-muted" />
                            ) : (
                              m.id === model && <Check className="size-4 text-foreground" />
                            )}
                          </DropdownMenu.Item>
                        );
                      })}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              )}

              <PromptInputAction
                tooltip={
                  isLoading
                    ? "Stop generation"
                    : isRecording
                      ? "Stop recording"
                      : isTranscribing
                        ? "Transcribing…"
                        : hasContent
                          ? "Send message"
                          : "Voice message"
                }
              >
                <Button
                  variant="default"
                  size="icon"
                  className={cn(
                    "m3-lift h-8 w-8 rounded-full transition-all duration-200",
                    isRecording
                      ? "bg-transparent text-red-500 hover:bg-chip hover:text-red-400"
                      : hasContent || isLoading
                        ? "bg-primary text-primary-foreground hover:opacity-90"
                        : "bg-transparent text-muted hover:bg-chip hover:text-foreground",
                  )}
                  onClick={() => {
                    if (isLoading) onStop?.();
                    else if (isRecording) stopRecording();
                    else if (hasContent) handleSubmit();
                    else if (!isTranscribing) void startRecording();
                  }}
                  disabled={(disabled && !isLoading) || isTranscribing}
                >
                  {isLoading ? (
                    <Square className="h-4 w-4 animate-pulse fill-primary-foreground" />
                  ) : isRecording ? (
                    <StopCircle className="h-5 w-5 text-red-500" />
                  ) : isTranscribing ? (
                    <Mic className="h-5 w-5 animate-pulse text-muted" />
                  ) : hasContent ? (
                    <ArrowUp className="h-4 w-4 text-primary-foreground" />
                  ) : (
                    <Mic className="h-5 w-5 text-muted transition-colors" />
                  )}
                </Button>
              </PromptInputAction>
            </div>
          </PromptInputActions>
        </PromptInput>
        <ImageViewDialog
          imageUrl={selectedImage}
          onClose={() => setSelectedImage(null)}
        />
        <VoiceMode
          open={voiceModeOpen}
          onClose={() => setVoiceModeOpen(false)}
          onSubmit={submitVoiceText}
        />
      </>
    );
  },
);
PromptInputBox.displayName = "PromptInputBox";
