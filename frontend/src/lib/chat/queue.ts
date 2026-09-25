import { create } from "zustand";
import type { Attachment } from "@/lib/chat/types";

/** Messages typed while a reply was still generating, per chat. They send one at a time, in
 *  order, as each turn finishes (see the drain in routes/index.tsx). */
export type QueuedMessage = { id: string; text: string; attachments: Attachment[] };

type QueueState = {
  byChat: Record<string, QueuedMessage[]>;
  enqueue: (chatId: string, item: QueuedMessage) => void;
  shift: (chatId: string) => QueuedMessage | undefined;
  remove: (chatId: string, id: string) => void;
};

export const useQueue = create<QueueState>((set, get) => ({
  byChat: {},
  enqueue: (chatId, item) =>
    set((s) => ({ byChat: { ...s.byChat, [chatId]: [...(s.byChat[chatId] ?? []), item] } })),
  shift: (chatId) => {
    const [head, ...rest] = get().byChat[chatId] ?? [];
    if (!head) return undefined;
    set((s) => ({ byChat: { ...s.byChat, [chatId]: rest } }));
    return head;
  },
  remove: (chatId, id) =>
    set((s) => ({ byChat: { ...s.byChat, [chatId]: (s.byChat[chatId] ?? []).filter((q) => q.id !== id) } })),
}));
