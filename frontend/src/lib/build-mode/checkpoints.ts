import { create } from "zustand";
import { api } from "@/lib/api";

/** Which user messages in a Build session have a restore point (backend projectBuild/checkpoints.ts). */
export const useBuildCheckpoints = create<{
  byConversation: Record<string, string[]>;
  load: (conversationId: string) => Promise<void>;
}>((set) => ({
  byConversation: {},
  load: async (conversationId) => {
    try {
      const res = await api.get<{ checkpoints: { messageId: string }[] }>(`/build/${conversationId}/checkpoints`);
      set((s) => ({ byConversation: { ...s.byConversation, [conversationId]: res.checkpoints.map((c) => c.messageId) } }));
    } catch {
      /* no restore buttons this time — nothing else depends on it */
    }
  },
}));
