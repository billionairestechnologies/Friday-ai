import { searchProject } from "../../knowledge/projectKnowledge.js";
import { num, str, type FridayTool } from "./types.js";

/** search_project_files: every chat in a project can look things up in the project's files. */
export function projectSearchTool(projectId: string, fileNames: string[]): FridayTool {
  return {
    spec: {
      name: "search_project_files",
      description:
        "Search the files saved in this chat's project (its knowledge base) and get back the most relevant passages with " +
        `their file names. Files: ${fileNames.slice(0, 40).join(", ")}${fileNames.length > 40 ? ", …" : ""}. Use it whenever the ` +
        "question could be answered from these files — before answering from memory or the web — and search again with " +
        "different words (names, numbers, synonyms) if the first results miss. Quote and name the file you used.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for — keywords, names, numbers, or a question" },
          limit: { type: "number", description: "How many passages (default 8, max 20)" },
        },
        required: ["query"],
      },
    },
    label: (args) => `Searched project files · "${str(args, "query").slice(0, 60)}"`,
    async run(args) {
      const hits = await searchProject(projectId, str(args, "query"), num(args, "limit", 8, 1, 20));
      if (!hits.length) return "No matching passages in the project's files. Try other words, or answer without them and say so.";
      return hits.map((h, i) => `[${i + 1}] ${h.filename} (part ${h.chunkIndex + 1})\n${h.content}`).join("\n\n---\n\n");
    },
  };
}
