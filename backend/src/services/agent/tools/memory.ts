import { addMemory, deleteMemory } from "../../memoryService.js";
import { str, type FridayTool } from "./types.js";

export const rememberTool: FridayTool = {
  spec: {
    name: "remember",
    description:
      "Save a short, durable fact about the user to long-term memory so it is available in future chats. Use when the user " +
      "asks you to remember something, or shares a stable preference/fact about themselves they'd clearly want kept " +
      "(name, role, preferences, ongoing projects). Never store passwords, secrets, or sensitive data they didn't ask to keep.",
    parameters: {
      type: "object",
      properties: { fact: { type: "string", description: "One concise fact, written in the third person, e.g. \"Prefers answers in Hindi\"" } },
      required: ["fact"],
    },
  },
  label: () => "Saved to memory",
  async run(args, ctx) {
    const memory = await addMemory(ctx.userId, str(args, "fact"), ctx.conversationId);
    return `Saved memory [${memory.id}]: ${memory.content}`;
  },
};

export const forgetTool: FridayTool = {
  spec: {
    name: "forget",
    description: "Delete one saved memory by its id (the id in square brackets in your memory list) when the user asks you to forget it or it is outdated.",
    parameters: { type: "object", properties: { memory_id: { type: "string", description: "The memory id" } }, required: ["memory_id"] },
  },
  label: () => "Removed a memory",
  async run(args, ctx) {
    const id = str(args, "memory_id");
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("memory_id must be a memory id from the memory list");
    return (await deleteMemory(ctx.userId, id)) ? "Memory deleted." : "No memory with that id.";
  },
};

export const MEMORY_TOOLS = [rememberTool, forgetTool];
