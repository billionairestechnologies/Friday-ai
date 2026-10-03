import type { AgentMessage, ToolCall, ToolSpec } from "../providers/toolCalling.js";
import type { ChatImage } from "../providers/types.js";
import type { TokenUsage } from "../tokenUsage.js";

/**
 * The Friday X gateway speaks the OpenAI chat-completions wire format: the CLI/IDE harness it is built on
 * already talks that dialect, and Friday's provider adapters already translate it to Anthropic, Gemini and
 * the rest (toolCalling.ts). This file is only the thin, pure translation between the two — no I/O.
 */

type OaContentPart = { type?: string; text?: string; image_url?: { url?: string } | string };
export type OaMessage = {
  role?: string;
  content?: string | OaContentPart[] | null;
  tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
  tool_call_id?: string;
  name?: string;
};
export type OaTool = { type?: string; function?: { name?: string; description?: string; parameters?: Record<string, unknown> } };

const MAX_MESSAGES = 2_000;
const MAX_TOOLS = 128;

/** Gemini's thoughtSignature must come back on the functionCall it belongs to, but the client only echoes the
 *  call id — so the signature rides inside the id we hand out ("call_x.<base64url>"). Stateless: any server
 *  instance can decode it, and it survives the harness's own history compaction. */
export function encodeCallId(call: Pick<ToolCall, "id" | "signature">): string {
  return call.signature ? `${call.id}.${Buffer.from(call.signature, "utf8").toString("base64url")}` : call.id;
}

export function decodeCallId(id: string): { id: string; signature?: string } {
  const dot = id.indexOf(".");
  if (dot <= 0) return { id };
  try {
    const signature = Buffer.from(id.slice(dot + 1), "base64url").toString("utf8");
    return signature ? { id: id.slice(0, dot), signature } : { id };
  } catch {
    return { id };
  }
}

function textOf(content: OaMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((p) => p?.type === "text" || p?.type === "input_text" || typeof p?.text === "string").map((p) => p.text ?? "").join("");
}

function imagesOf(content: OaMessage["content"]): ChatImage[] {
  if (!Array.isArray(content)) return [];
  const out: ChatImage[] = [];
  for (const part of content) {
    const url = typeof part?.image_url === "string" ? part.image_url : part?.image_url?.url;
    const match = typeof url === "string" ? /^data:(image\/[\w.+-]+);base64,/.exec(url) : null;
    if (url && match) out.push({ mime: match[1]!, dataUrl: url, kind: "image" });
  }
  return out;
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function toAgentMessages(messages: OaMessage[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  const callNames = new Map<string, string>();
  for (const m of messages.slice(-MAX_MESSAGES)) {
    const role = m.role;
    if (role === "system" || role === "developer") {
      const content = textOf(m.content);
      if (content) out.push({ role: "system", content });
    } else if (role === "user") {
      const images = imagesOf(m.content);
      out.push({ role: "user", content: textOf(m.content), ...(images.length ? { images } : {}) });
    } else if (role === "assistant") {
      const calls: ToolCall[] = (m.tool_calls ?? [])
        .filter((c) => c?.function?.name)
        .map((c, i) => {
          const decoded = decodeCallId(c.id ?? `call_${i}`);
          callNames.set(c.id ?? `call_${i}`, c.function!.name!);
          return { id: decoded.id, name: c.function!.name!, args: parseArgs(c.function!.arguments), ...(decoded.signature ? { signature: decoded.signature } : {}) };
        });
      out.push(calls.length ? { role: "assistant", content: textOf(m.content), toolCalls: calls } : { role: "assistant", content: textOf(m.content) });
    } else if (role === "tool") {
      const raw = m.tool_call_id ?? "";
      out.push({ role: "tool", toolCallId: decodeCallId(raw).id, name: m.name ?? callNames.get(raw) ?? "tool", content: textOf(m.content) });
    }
  }
  return out;
}

export function toToolSpecs(tools: OaTool[] | undefined): ToolSpec[] {
  const specs: ToolSpec[] = [];
  for (const t of (tools ?? []).slice(0, MAX_TOOLS)) {
    const fn = t?.function;
    if (!fn?.name) continue;
    const params = fn.parameters && typeof fn.parameters === "object" ? fn.parameters : {};
    specs.push({
      name: fn.name,
      description: fn.description ?? "",
      parameters: {
        type: "object",
        properties: (params.properties as Record<string, unknown> | undefined) ?? {},
        ...(Array.isArray(params.required) && params.required.length ? { required: params.required as string[] } : {}),
      },
    });
  }
  return specs;
}

/** Characters the request will make the model read — the pre-flight credit estimate is built from this. */
export function promptChars(messages: AgentMessage[], tools: ToolSpec[]): number {
  let n = 0;
  for (const m of messages) {
    n += m.content.length;
    if ("toolCalls" in m && Array.isArray(m.toolCalls)) for (const c of m.toolCalls) n += JSON.stringify(c.args).length + c.name.length;
    if ("images" in m && Array.isArray(m.images)) n += m.images.length * 1_500;
  }
  return n + JSON.stringify(tools).length;
}

export type Chunk = Record<string, unknown>;

export function chunkBase(id: string, model: string) {
  return { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
}

export function textChunk(id: string, model: string, text: string, first: boolean): Chunk {
  return { ...chunkBase(id, model), choices: [{ index: 0, delta: { ...(first ? { role: "assistant" } : {}), content: text }, finish_reason: null }] };
}

export function toolCallsChunk(id: string, model: string, calls: ToolCall[], first: boolean): Chunk {
  return {
    ...chunkBase(id, model),
    choices: [
      {
        index: 0,
        delta: {
          ...(first ? { role: "assistant" } : {}),
          tool_calls: calls.map((c, index) => ({ index, id: encodeCallId(c), type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })),
        },
        finish_reason: null,
      },
    ],
  };
}

export function finishChunk(id: string, model: string, reason: "stop" | "tool_calls" | "length"): Chunk {
  return { ...chunkBase(id, model), choices: [{ index: 0, delta: {}, finish_reason: reason }] };
}

export function usageBlock(usage: TokenUsage) {
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
    prompt_tokens_details: { cached_tokens: usage.cachedTokens ?? 0 },
  };
}

export function usageChunk(id: string, model: string, usage: TokenUsage): Chunk {
  return { ...chunkBase(id, model), choices: [], usage: usageBlock(usage) };
}

export function completionBody(id: string, model: string, text: string, calls: ToolCall[], usage: TokenUsage) {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          ...(calls.length ? { tool_calls: calls.map((c) => ({ id: encodeCallId(c), type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}),
        },
        finish_reason: calls.length ? "tool_calls" : "stop",
      },
    ],
    usage: usageBlock(usage),
  };
}

/** "provider/model-id" (model ids may themselves contain slashes — only the first one separates). */
export function parseModelRef(ref: string): { slug: string; modelId: string } | null {
  const i = ref.indexOf("/");
  if (i <= 0 || i === ref.length - 1) return null;
  return { slug: ref.slice(0, i), modelId: ref.slice(i + 1) };
}

export function modelRef(slug: string, modelId: string): string {
  return `${slug}/${modelId}`;
}

export function openAiError(message: string, type: string, code?: string) {
  return { error: { message, type, ...(code ? { code } : {}) } };
}
