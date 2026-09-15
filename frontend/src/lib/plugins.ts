export type PluginItem = {
  id: string;
  name: string;
  desc: string;
  group: "connected" | "featured";
};

export const FRIDAY_TOOLS: PluginItem[] = [
  { id: "search", name: "Web Search", desc: "Live web results in the reply", group: "connected" },
  { id: "think", name: "Think", desc: "Show the reasoning trail", group: "connected" },
  { id: "canvas", name: "Canvas", desc: "Open a right-side workspace for builds", group: "connected" },
];

export const FEATURED_PLUGINS: PluginItem[] = [
  { id: "calendar", name: "Google Calendar", desc: "See events and upcoming meetings", group: "featured" },
  { id: "github", name: "GitHub", desc: "Search repos and pull requests", group: "featured" },
  { id: "gmail", name: "Gmail", desc: "Read and draft mail", group: "featured" },
  { id: "drive", name: "Google Drive", desc: "Search files and docs", group: "featured" },
  { id: "notion", name: "Notion", desc: "Search pages and docs", group: "featured" },
  { id: "finance", name: "Finance", desc: "Connect financial accounts", group: "featured" },
  { id: "box", name: "Box", desc: "Search files and docs", group: "featured" },
  { id: "canva", name: "Canva", desc: "Create and edit designs", group: "featured" },
  { id: "stripe", name: "Stripe", desc: "Look up payments", group: "featured" },
  { id: "vercel", name: "Vercel", desc: "Manage your deploys", group: "featured" },
];
