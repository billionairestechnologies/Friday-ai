import type { LucideIcon } from "lucide-react";
import {
  BookOpenCheck,
  Brain,
  CalendarClock,
  Code2,
  FileSearch,
  GitPullRequest,
  Globe,
  Layers,
  Mail,
  MessagesSquare,
  Mic,
  PanelsTopLeft,
  Plug,
  Server,
  ShieldCheck,
  Sparkles,
  Users,
  Workflow,
  Zap,
} from "lucide-react";

export type SiteSlug = "overview" | "build" | "research" | "connectors" | "models" | "automations";

export type SitePage = {
  slug: SiteSlug;
  /** Short label for navigation. */
  nav: string;
  /** Browser tab title — must match backend/src/seo.ts so crawls and client navigation agree. */
  metaTitle: string;
  eyebrow: string;
  headline: string;
  lead: string;
  cta: string;
  features: { icon: LucideIcon; title: string; body: string }[];
  steps?: { title: string; body: string }[];
  faq: { q: string; a: string }[];
};

export const SITE_PAGES: Record<SiteSlug, SitePage> = {
  overview: {
    slug: "overview",
    nav: "Overview",
    metaTitle: "Overview — Friday AI",
    eyebrow: "Friday",
    headline: "One assistant. Every top model.",
    lead: "Friday brings GPT, Claude, Gemini and more into one place — and gives them real tools: live web search, deep research, a coding sandbox, your connected apps, memory and scheduled tasks.",
    cta: "Start chatting",
    features: [
      { icon: Layers, title: "Every top model", body: "Choose a model yourself, let Auto pick the best one for each message, or have several answer together with Team Up." },
      { icon: Globe, title: "Live web search", body: "Answers grounded in today's web, with the sources linked so you can check them." },
      { icon: FileSearch, title: "Deep Research", body: "Friday reads dozens of sources and writes a cited report for questions that need more than one search." },
      { icon: Code2, title: "Build Mode", body: "Describe an app and Friday writes, runs and fixes the code in a cloud sandbox, with a live preview." },
      { icon: Plug, title: "Connectors", body: "Gmail, Drive, Calendar, GitHub, Notion and more — or any MCP server — so Friday can work with your real data." },
      { icon: Brain, title: "Memory", body: "Friday remembers what matters about you across chats. You can see and edit everything it remembers." },
      { icon: CalendarClock, title: "Automations", body: "Schedule a prompt to run hourly, daily or weekly, and get notified when the result is ready." },
      { icon: PanelsTopLeft, title: "Canvas", body: "Web pages, React components and code open side by side with the chat, runnable and editable." },
      { icon: Mic, title: "Voice", body: "Talk to Friday hands-free with natural-sounding voices." },
    ],
    faq: [
      { q: "What is Friday?", a: "Friday is an AI assistant by Billionaires Technologies that lets you use the leading AI models from one app, with tools for web search, research, coding, your connected apps and scheduled tasks." },
      { q: "Is Friday free?", a: "Yes. The Free plan lets you chat with a selection of models every day. Pro and Premium add more usage and the most capable models." },
      { q: "Which models can I use?", a: "Models from OpenAI, Anthropic, Google and others, depending on your plan. The model list updates as new models are added." },
      { q: "Where can I use Friday?", a: "On the web at friday.billionairestechnologies.com today. Android and iOS apps are on the way." },
    ],
  },
  models: {
    slug: "models",
    nav: "Models",
    metaTitle: "Models — GPT, Claude, Gemini and more in Friday",
    eyebrow: "Models",
    headline: "The best model for every message.",
    lead: "Stop switching between apps and subscriptions. Friday puts the leading models side by side, and can pick — or combine — them for you.",
    cta: "Try the models",
    features: [
      { icon: Sparkles, title: "Auto", body: "Friday reads your message and routes it to the model best suited to it — fast models for quick questions, strong reasoners for hard ones." },
      { icon: Users, title: "Team Up", body: "Several models answer the same question and Friday combines their best ideas into one reply. More models join when the task calls for it." },
      { icon: MessagesSquare, title: "Pick any model", body: "Prefer a specific model? Choose it from the model menu and switch any time, mid-conversation." },
      { icon: Zap, title: "Fast by default", body: "Replies stream as they're written, and Friday hedges slow requests so you're rarely left waiting." },
    ],
    faq: [
      { q: "Which providers does Friday use?", a: "OpenAI, Anthropic, Google Gemini, OpenRouter and others. Available models depend on your plan." },
      { q: "What is Team Up?", a: "Team Up asks several models the same question at once and merges their answers, which helps on questions where a second opinion matters." },
    ],
  },
  build: {
    slug: "build",
    nav: "Build",
    metaTitle: "Friday Build — describe an app, get a running app",
    eyebrow: "Friday Build",
    headline: "Describe it. Friday builds it.",
    lead: "Build Mode is a coding agent: it plans the project, writes and edits the code, installs packages, runs it in a secure cloud sandbox and fixes what breaks — with a live preview as it goes.",
    cta: "Start building",
    features: [
      { icon: Server, title: "Real sandbox", body: "Every project runs in an isolated cloud machine, so the code is actually executed and tested, not just written." },
      { icon: PanelsTopLeft, title: "Live preview", body: "See the running app next to the chat and keep refining it in plain language." },
      { icon: GitPullRequest, title: "GitHub pull requests", body: "Import a repository, let Friday make the change, and get a pull request back." },
      { icon: BookOpenCheck, title: "Asks before it guesses", body: "For open-ended requests, Friday asks a few quick questions first so the first version is the one you wanted." },
    ],
    steps: [
      { title: "Describe", body: "Say what you want — a landing page, a dashboard, a tool, a fix in your repo." },
      { title: "Watch it build", body: "Friday plans, writes files, runs commands and checks its own work." },
      { title: "Ship", body: "Preview it live, download the project, or open a pull request." },
    ],
    faq: [
      { q: "Do I need to know how to code?", a: "No. Describe what you want in plain language. If you do code, you can import a GitHub repository and review the pull request Friday opens." },
      { q: "Where does the code run?", a: "In a private, isolated cloud sandbox created for your project." },
    ],
  },
  research: {
    slug: "research",
    nav: "Research",
    metaTitle: "Deep Research — Friday AI",
    eyebrow: "Deep Research",
    headline: "Hours of research, in minutes.",
    lead: "Turn on Deep Research and Friday plans the question, searches widely, reads the sources and writes a structured report with citations you can follow.",
    cta: "Ask a research question",
    features: [
      { icon: Globe, title: "Searches widely", body: "Many searches across many sites, not a single query." },
      { icon: FileSearch, title: "Reads the sources", body: "Friday opens and reads the pages themselves instead of relying on search snippets." },
      { icon: BookOpenCheck, title: "Cites everything", body: "Every claim links back to where it came from." },
      { icon: CalendarClock, title: "On a schedule", body: "Run the same research every week with Automations and keep up with what changed." },
    ],
    faq: [
      { q: "How is this different from normal search?", a: "Normal chat does a quick search when it helps. Deep Research runs a multi-step investigation and produces a full report." },
    ],
  },
  connectors: {
    slug: "connectors",
    nav: "Connectors",
    metaTitle: "Connectors — Friday AI",
    eyebrow: "Connectors",
    headline: "Friday, working with your apps.",
    lead: "Connect the tools you already use and ask Friday to read, find and act across them — your inbox, files, calendar, code and more.",
    cta: "Connect your apps",
    features: [
      { icon: Mail, title: "Google Workspace", body: "Gmail, Google Drive and Google Calendar — summarise email, find files, check your schedule." },
      { icon: GitPullRequest, title: "GitHub", body: "Browse repositories, read code and open pull requests." },
      { icon: Workflow, title: "Notion, Vercel, Railway, Supabase, Razorpay", body: "Look things up and get status from the services you run your work and business on." },
      { icon: Plug, title: "Any MCP server", body: "Add a remote MCP server and Friday can use its tools too." },
      { icon: ShieldCheck, title: "You stay in control", body: "Connect or disconnect any time. Credentials are encrypted, and every connector action is logged." },
    ],
    faq: [
      { q: "What is MCP?", a: "The Model Context Protocol is an open standard for giving AI assistants tools. Any compatible remote server can be connected to Friday." },
    ],
  },
  automations: {
    slug: "automations",
    nav: "Automations",
    metaTitle: "Automations — Friday AI",
    eyebrow: "Automations",
    headline: "Friday works while you don't.",
    lead: "Give Friday a task and a schedule. It runs on time, uses the same tools as chat — web search, research, your connected apps — and notifies you when it's done.",
    cta: "Create an automation",
    features: [
      { icon: CalendarClock, title: "Any schedule", body: "Hourly, daily, weekdays or weekly, in your own time zone." },
      { icon: FileSearch, title: "Full tools", body: "Automations can search the web, run Deep Research and use your connectors." },
      { icon: MessagesSquare, title: "Results in chat", body: "Each run lands in its own conversation, so you can ask follow-ups." },
    ],
    steps: [
      { title: "Morning news brief", body: "Today's top stories with sources, every morning at 8." },
      { title: "Weekly competitor watch", body: "What your competitors announced this week, summarised." },
      { title: "Inbox digest", body: "Unread email summarised, with what needs a reply." },
    ],
    faq: [
      { q: "Do I need to keep Friday open?", a: "No. Automations run on Friday's servers and the results are waiting for you." },
    ],
  },
};

/** Order used for navigation on every public page. Plans lives at /plans (the pricing page). */
export const SITE_NAV: { label: string; to: string }[] = [
  { label: "Overview", to: "/overview" },
  { label: "Models", to: "/models" },
  { label: "Build", to: "/build" },
  { label: "Research", to: "/research" },
  { label: "Connectors", to: "/connectors" },
  { label: "Automations", to: "/automations" },
  { label: "Plans", to: "/plans" },
];
