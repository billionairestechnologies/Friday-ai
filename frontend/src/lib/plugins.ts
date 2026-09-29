export type PluginCategory = "Productivity" | "Developer tools" | "Business & finance" | "Design";

export const PLUGIN_CATEGORIES: PluginCategory[] = ["Productivity", "Developer tools", "Business & finance", "Design"];

export type PluginItem = {
  id: string;
  name: string;
  desc: string;
  group: "connected" | "featured";
  category?: PluginCategory;
};

export const FRIDAY_TOOLS: PluginItem[] = [
  { id: "search", name: "Web Search", desc: "Live web results in the reply", group: "connected" },
  { id: "think", name: "Think", desc: "Show the reasoning trail", group: "connected" },
  { id: "canvas", name: "Canvas", desc: "Open a right-side workspace for builds", group: "connected" },
  { id: "research", name: "Deep Research", desc: "Many searches + full sources → a cited report", group: "connected" },
];

export const FEATURED_PLUGINS: PluginItem[] = [
  { id: "gmail", name: "Gmail", desc: "Read and draft mail", group: "featured", category: "Productivity" },
  { id: "calendar", name: "Google Calendar", desc: "See events and upcoming meetings", group: "featured", category: "Productivity" },
  { id: "drive", name: "Google Drive", desc: "Search files and docs", group: "featured", category: "Productivity" },
  { id: "notion", name: "Notion", desc: "Search pages and docs", group: "featured", category: "Productivity" },
  { id: "box", name: "Box", desc: "Search files and docs", group: "featured", category: "Productivity" },
  { id: "github", name: "GitHub", desc: "Search repos and pull requests", group: "featured", category: "Developer tools" },
  { id: "supabase", name: "Supabase", desc: "Query your database and tables", group: "featured", category: "Developer tools" },
  { id: "vercel", name: "Vercel", desc: "Manage your deploys", group: "featured", category: "Developer tools" },
  { id: "railway", name: "Railway", desc: "Check deploys and service status", group: "featured", category: "Developer tools" },
  { id: "razorpay", name: "Razorpay", desc: "Track payments and orders", group: "featured", category: "Business & finance" },
  { id: "finance", name: "Finance", desc: "Connect financial accounts", group: "featured", category: "Business & finance" },
  { id: "canva", name: "Canva", desc: "Create and edit designs", group: "featured", category: "Design" },
];
