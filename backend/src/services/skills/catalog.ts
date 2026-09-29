/**
 * Built-in skills: expert playbooks Friday can load on demand. A skill is instructions, not code —
 * when a request matches one (or the user picks it), its playbook is added to the model's context
 * so the answer follows a proven process and format instead of a generic one. Written to be
 * model-agnostic and to lean on Friday's own tools (web_search, run_code, create_document).
 */

export type SkillCategory = "Documents & slides" | "Writing" | "Research & analysis" | "Code & product" | "Business" | "Learning & life";

export type BuiltinSkill = {
  id: string;
  name: string;
  category: SkillCategory;
  /** Emoji shown on the skill tile. */
  icon: string;
  /** One line: WHEN to use it — this is what the model matches requests against. */
  description: string;
  instructions: string;
};

export const SKILL_CATEGORIES: SkillCategory[] = ["Documents & slides", "Writing", "Research & analysis", "Code & product", "Business", "Learning & life"];

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  {
    id: "pitch-deck",
    name: "Pitch deck builder",
    category: "Documents & slides",
    icon: "📊",
    description: "Investor, sales or project presentations — a complete, persuasive .pptx deck.",
    instructions: `Build a presentation people remember.
1. Clarify the audience and the ONE decision you want from them; if the user didn't say, infer it and state your assumption in one line.
2. Research facts you need (market size, competitors, numbers) with web_search — cite sources in the speaker notes, never invent figures.
3. Structure (adapt to purpose): Title → Problem → Why now → Solution → How it works → Market/size → Traction or proof → Business model → Competition (a 2x2 or table) → Team → Roadmap → The ask → Close.
4. One idea per slide. Titles are full-sentence takeaways ("Churn fell 40% after onboarding v2"), not labels ("Churn").
5. Max 5 bullets, max ~12 words each. Use the stats layout for 2-4 headline numbers, chart for trends, table for comparisons, two_column for before/after.
6. Put the talking points (what to SAY) in each slide's notes.
7. Create the file with create_document (format pptx). Then reply with a 3-line summary of the storyline and offer one improvement.`,
  },
  {
    id: "excel-model",
    name: "Spreadsheet & financial model",
    category: "Documents & slides",
    icon: "🧮",
    description: "Budgets, trackers, financial models, forecasts or any .xlsx with working formulas.",
    instructions: `Build spreadsheets that calculate, not just display.
1. Separate sheets: Inputs/Assumptions (clearly labelled, one assumption per row), Calculations, Summary/Dashboard.
2. Every derived number is a FORMULA referencing inputs (e.g. "=B4*(1+B5)") — never a hard-coded result. Totals use SUM, growth uses the assumption cells.
3. Headers in row 1, one record per row, consistent units (state units in the header: "Revenue (₹)").
4. For forecasts: monthly or yearly columns, show the growth/driver assumptions explicitly, add a sanity-check row.
5. Verify tricky arithmetic with run_code before writing the file.
6. Create the file with create_document (format xlsx). In the reply, list the sheets, the key assumptions to edit, and the headline outputs.`,
  },
  {
    id: "report-writer",
    name: "Professional report",
    category: "Documents & slides",
    icon: "📄",
    description: "Reports, white papers, briefs and proposals as polished Word or PDF documents.",
    instructions: `Write a report a busy executive can act on.
1. Start with an Executive summary: the conclusion and recommendation in 3-5 sentences.
2. Then sections with clear headings: Background, Findings (with evidence and numbers), Analysis, Options (a comparison table), Recommendation, Next steps (owner + date), Appendix/Sources.
3. Research anything factual with web_search and cite sources as links.
4. Short paragraphs, informative headings, tables for comparisons, bold only for the key figure in a paragraph.
5. Create the file with create_document — docx by default (editable), pdf if the user asked for PDF or a final/printable copy. Summarise the key findings in the reply.`,
  },
  {
    id: "resume",
    name: "Resume & cover letter",
    category: "Writing",
    icon: "🧑‍💼",
    description: "Resumes/CVs, cover letters and LinkedIn profiles tailored to a job.",
    instructions: `Make the candidate the obvious hire for THIS role.
1. If a job description is given, extract its top 6-8 requirements and mirror their language (ATS keywords) truthfully.
2. Resume: Name + contact line; 2-3 line summary aimed at the role; Experience in reverse order with 3-5 bullets each, every bullet = action verb + what + measurable result ("Cut page load 45% by…"); Skills grouped; Education; optional Projects/Certifications.
3. One page for <10 years' experience. No photos, no "References available".
4. Never invent employers, dates, degrees or numbers — if a metric is missing, ask or use a clearly marked placeholder like [X%].
5. Cover letter: 3 short paragraphs — why this company, proof you can do the job (2 achievements), confident close.
6. Offer the resume as a .docx via create_document.`,
  },
  {
    id: "email-writer",
    name: "Emails that get replies",
    category: "Writing",
    icon: "✉️",
    description: "Cold outreach, follow-ups, difficult or formal emails, and replies.",
    instructions: `Write emails people actually answer.
1. Subject: specific and short (under 7 words), no clickbait.
2. First line is about THEM, not you. State the purpose within two sentences.
3. One clear ask, easy to say yes to (a 15-minute call on Tue/Wed, a yes/no question).
4. Under 120 words for cold emails; use short paragraphs; no walls of text.
5. Match the tone asked for (warm, formal, firm). For difficult emails: acknowledge, state facts, propose a way forward, no blame.
6. Give 2 subject line options and, for outreach, a 2-line follow-up to send 3 days later.
If Gmail is connected and the user asks, draft it there; otherwise show the email ready to copy.`,
  },
  {
    id: "seo-article",
    name: "SEO blog article",
    category: "Writing",
    icon: "📝",
    description: "Long-form blog posts and articles written to rank and to be read.",
    instructions: `Write an article that answers the searcher better than the current top results.
1. Identify the primary keyword and search intent; check the top results with web_search to see what they cover and what they miss.
2. Title (under 60 chars, keyword near the front) and a meta description (under 155 chars).
3. Hook intro (2-3 sentences) that states the answer or promise. Then H2/H3 sections that follow the reader's questions, a comparison table or checklist where useful, and an FAQ with 3-5 real questions.
4. Concrete examples, numbers with sources (linked), no filler, no keyword stuffing. Short paragraphs, scannable.
5. End with a clear conclusion/next step. Suggest 3 internal-link ideas and an image idea for the header.`,
  },
  {
    id: "deep-research",
    name: "Research analyst",
    category: "Research & analysis",
    icon: "🔎",
    description: "Thorough, sourced answers to complex questions: markets, comparisons, due diligence.",
    instructions: `Research like an analyst, not a search box.
1. Break the question into 4-6 sub-questions and research each with several varied web_search queries; read the best primary sources with fetch_url.
2. Prefer official data, filings, papers and reputable outlets; note dates — flag anything older than a year.
3. Cross-check surprising numbers with a second source; state disagreements openly.
4. Answer with: bottom line first, then a section per sub-question with specifics (numbers, names, dates), a comparison table when comparing, "What's uncertain", and Sources.
5. Cite inline as markdown links. Never present a guess as a fact.`,
  },
  {
    id: "data-analyst",
    name: "Data analyst",
    category: "Research & analysis",
    icon: "📈",
    description: "Analyse CSV/Excel data or numbers: trends, summaries, charts and insights.",
    instructions: `Turn data into decisions.
1. First describe the data: rows, columns, types, date range, obvious quality issues (missing values, duplicates, outliers).
2. Use run_code (pandas) for every calculation — never estimate numbers by eye. Show the key code result, not the whole code, unless asked.
3. Answer the user's question directly, then 3-5 insights ranked by business impact, each with the number that proves it.
4. Suggest the right chart for each insight; if a deliverable is useful, build an .xlsx (with formulas) or a .pptx summary via create_document.
5. End with limitations (sample size, missing data) and one recommended next analysis.`,
  },
  {
    id: "meeting-notes",
    name: "Meeting notes & actions",
    category: "Business",
    icon: "🗒️",
    description: "Turn transcripts or rough notes into clear minutes, decisions and action items.",
    instructions: `Produce minutes someone who missed the meeting can act on.
Format:
- **Summary** — 2-3 sentences: purpose and outcome.
- **Decisions** — numbered, each one sentence.
- **Action items** — table: Task | Owner | Due date | Notes. Infer owners/dates only when stated; otherwise mark "TBD".
- **Open questions / risks**.
- **Discussion notes** — grouped by topic, concise bullets.
Remove filler and small talk; keep names and numbers exact. Offer a .docx copy via create_document and, if Calendar is connected and the user wants, a follow-up meeting suggestion.`,
  },
  {
    id: "business-plan",
    name: "Business plan & strategy",
    category: "Business",
    icon: "🚀",
    description: "Business plans, go-to-market strategy, SWOT, pricing and competitor analysis.",
    instructions: `Think like a strategy consultant — specific, numeric, honest.
1. Clarify the business, customer and geography (assume India/INR if unclear and say so).
2. Research the market and 3-5 real competitors with web_search: pricing, positioning, strengths/weaknesses.
3. Deliver: problem & customer, value proposition, market size (TAM/SAM/SOM with the method shown), competitor table, go-to-market (channels, first 90 days), pricing with rationale, unit economics (CAC, LTV, margin — show the math), risks with mitigations, milestones.
4. Use frameworks (SWOT, Porter, jobs-to-be-done) only when they add insight.
5. Offer the plan as a .docx and a short investor deck (.pptx) via create_document.`,
  },
  {
    id: "contract-review",
    name: "Contract review",
    category: "Business",
    icon: "⚖️",
    description: "Review agreements, NDAs, offer letters or terms and flag risky clauses (not legal advice).",
    instructions: `Review the document like a careful in-house counsel — and say clearly this is not legal advice.
1. Summarise the deal in plain language: parties, what each side gives, money, term, termination.
2. Risk table: Clause | What it says | Why it matters | Risk (High/Med/Low) | Suggested change. Cover liability caps, indemnities, IP ownership, confidentiality, non-compete/non-solicit, payment terms, auto-renewal, termination, governing law/jurisdiction, data protection.
3. Flag anything missing that normally should be there.
4. Provide suggested redline wording for the top 3 risks.
5. Recommend consulting a qualified lawyer for high-risk items or anything jurisdiction-specific.`,
  },
  {
    id: "code-review",
    name: "Senior code reviewer",
    category: "Code & product",
    icon: "🧑‍💻",
    description: "Review code or a pull request for bugs, security, performance and clarity.",
    instructions: `Review like a senior engineer who has to maintain this code.
1. Understand intent first; restate what the change does in one line.
2. Look for, in order: correctness bugs and edge cases (null/empty, off-by-one, concurrency, error paths), security (injection, auth checks, secrets, SSRF, unsafe deserialisation), data loss, performance (N+1, unbounded loops/memory), API/contract breaks, then readability and tests.
3. For each finding: severity (blocker / should-fix / nit), file:line if known, why it matters, and a concrete fix (code).
4. Don't nitpick style a formatter would fix. Praise one thing that's genuinely good.
5. If GitHub is connected and a PR/repo is referenced, read the actual files with the GitHub tools before judging.`,
  },
  {
    id: "debugger",
    name: "Debugging detective",
    category: "Code & product",
    icon: "🐞",
    description: "Find the root cause of an error, stack trace or 'it doesn't work' bug.",
    instructions: `Debug systematically — root cause, not symptoms.
1. Restate the observed vs expected behaviour. Ask for the exact error, stack trace, versions and a minimal reproduction if missing.
2. Read the stack trace bottom-up to the first frame in the user's code. Form 2-3 ranked hypotheses with the evidence for each.
3. Propose the fastest experiment to confirm/refute the top hypothesis (a log line, a one-line change, run_code to reproduce).
4. Give the fix with the minimal diff, explain WHY it happened, and how to prevent the class of bug (test, type, lint rule).
5. Search the web for the exact error message when it's library-specific; cite the issue/doc you rely on.`,
  },
  {
    id: "prd",
    name: "Product spec (PRD)",
    category: "Code & product",
    icon: "🧭",
    description: "Product requirement documents, feature specs, user stories and acceptance criteria.",
    instructions: `Write a spec engineers can build from and PMs can defend.
Sections: Problem & evidence · Goals and non-goals · Users & jobs-to-be-done · User stories ("As a…, I want…, so that…") with acceptance criteria (Given/When/Then) · UX flow (step list; note empty/error/loading states) · Requirements (functional, then non-functional: performance, security, accessibility, analytics events) · Edge cases · Rollout plan (flags, phases, success metrics with targets) · Risks & open questions.
Keep each requirement testable. Prioritise with MoSCoW. Offer the PRD as a .docx via create_document.`,
  },
  {
    id: "tutor",
    name: "Patient tutor",
    category: "Learning & life",
    icon: "🎓",
    description: "Learn or teach a topic step by step: explanations, practice questions, lesson plans.",
    instructions: `Teach for understanding, not just answers.
1. Gauge level from the question (or ask one quick question). Use the learner's language if they write in Hindi or another language.
2. Explain with a simple intuition first, then the precise idea, then a worked example. Use analogies from everyday Indian life where natural.
3. Check understanding with 2-3 short practice questions; reveal answers only after they try (or in a collapsible "Answers" section if they want them now).
4. For maths/science, verify calculations with run_code. For exams, point out common mistakes.
5. For teachers: produce lesson plans with objectives, timing, activities and an assessment; offer slides via create_document.`,
  },
  {
    id: "social-media",
    name: "Social media content",
    category: "Learning & life",
    icon: "📱",
    description: "Posts, captions, threads, reels scripts and content calendars for any platform.",
    instructions: `Create content native to each platform.
1. Ask or infer: brand voice, audience, platform(s), goal (awareness, leads, sales).
2. Hooks first: the first line/3 seconds must stop the scroll. Give 3 hook options.
3. Platform rules: LinkedIn — story + insight, line breaks, 1 CTA; Instagram — caption + 5-10 relevant hashtags; X — punchy, threads numbered; YouTube/Reels — script with timestamps, on-screen text and B-roll ideas.
4. For calendars: a table with Date | Platform | Format | Topic | Hook | CTA, mixing educational, social-proof and promotional posts (roughly 60/30/10). Offer it as .xlsx via create_document.
5. No fake statistics or testimonials.`,
  },
];

export function builtinSkill(id: string): BuiltinSkill | undefined {
  return BUILTIN_SKILLS.find((s) => s.id === id);
}
