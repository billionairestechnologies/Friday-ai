/**
 * The actual Privacy Policy and Terms of Service, in one place so backend/src/seo.ts's page
 * description, the /privacy and /terms pages, and the consent gate (consent-gate.tsx) all agree.
 *
 * POLICY_VERSION must exactly match backend/src/services/policyService.ts's POLICY_VERSION —
 * that's what every client compares against a signed-in account's saved acceptance to decide
 * whether to show the blocking "I agree" gate. Bump both together, and only for a change users
 * should actively re-agree to (not a typo fix).
 *
 * Every claim below was checked against this codebase before being written — see the migrations
 * under supabase/migrations/, backend/src/services/connectorService.ts,
 * backend/src/services/providers/, backend/src/controllers/authController.ts (export/delete
 * already exist), and backend/src/utils/crypto.ts (AES-256-GCM at rest). Nothing here is
 * boilerplate copied from another product — if a feature described here changes, update the
 * paragraph that describes it, not just the code.
 */
export const POLICY_VERSION = "2026-09-28";
export const POLICY_EFFECTIVE_DATE = "28 September 2026";
export const CONTACT_EMAIL = "admin.billionairestechnologies@gmail.com";
export const COMPANY_NAME = "Billionaires Technologies";

export type LegalSection = { heading: string; body: string[] };

export const PRIVACY_SECTIONS: LegalSection[] = [
  {
    heading: "Who we are",
    body: [
      `Friday is built and operated by ${COMPANY_NAME} ("Friday", "we", "us"). This policy covers the Friday web app at friday.billionairestechnologies.com and the Friday apps for Android and iOS. If you have questions about this policy or your data, contact us at ${CONTACT_EMAIL}.`,
    ],
  },
  {
    heading: "Account information",
    body: [
      "When you create a Friday account we collect your name, email address, phone number, date of birth, and a password (stored hashed by our authentication provider, Supabase Auth — we never see or store your password in plain text). If you sign in with Google or GitHub instead, we receive your name, email address, and profile ID from that provider rather than a password.",
      "We send a one-time 6-digit code to your email address every time you sign in, as a second verification step. We use Resend to deliver that email.",
    ],
  },
  {
    heading: "What you send Friday, and where it goes",
    body: [
      "Your messages, any files or images you attach, and Friday's replies are stored in our database so your conversation history is there the next time you open the app, and so Friday can refer back to earlier messages in the same chat.",
      "To generate a reply, the message content of your conversation is sent to the AI model provider behind whichever model you picked (or that Auto/Team Up picked for you). Depending on your choice, that is OpenAI, Anthropic, Google (Gemini), OpenRouter, Sarvam AI, a self-hosted Ollama model, or ScaleMax (a third-party relay that provides access to a Claude-based model we display as \"Claude Fable 5\"). Each of these providers processes the message text to generate the reply; we do not control their own data retention, and we encourage you to review their privacy policies if you have concerns about a specific provider. We do not sell your conversations to anyone, for any purpose.",
      "If you turn on voice mode, your speech is sent to ElevenLabs to convert it to and from audio.",
      "If you ask Friday to search the web or turned on the web search option, your query terms are sent to the search provider we use, and the pages Friday reads to answer you are fetched by our servers.",
    ],
  },
  {
    heading: "Memory",
    body: [
      "Friday can remember short facts about you across conversations — the kind of thing you'd tell an assistant once and expect it to remember later — but only when you ask it to remember something, or when the app itself decides a fact is worth keeping (for example, a correction you gave it). You can see everything Friday has remembered about you, and delete any of it, from Settings. Deleting a memory removes it immediately.",
    ],
  },
  {
    heading: "Connecting your other accounts",
    body: [
      "Friday can connect to Gmail, Google Calendar and Google Drive, GitHub, and services like Notion, Vercel, Railway, Supabase and Razorpay, but only if you explicitly connect them yourself from Settings — none of these are connected by default. For Google, we request read-only access to your calendar, Gmail, and Drive (we cannot send email or delete your files through this connection). For GitHub, we request read access plus the ability to open pull requests on repositories you choose, since that's what Build Mode uses it for.",
      "The access token for each connected account is encrypted (AES-256-GCM) before it's stored, and is only decrypted in memory, on our server, at the moment it's needed to carry out a request you made. You can disconnect any of these at any time from Settings, which deletes the stored token immediately. We keep a log of when a connector is connected or disconnected, for your own security review.",
      "You can also add your own remote MCP (Model Context Protocol) server as a connector. Anything Friday sends to that server is between you and that server's operator — we don't inspect or log the content of those calls beyond what's needed to relay them.",
    ],
  },
  {
    heading: "Automations",
    body: [
      "If you schedule an automation (a prompt that runs on a schedule you set, like a daily news brief), it runs on our servers at the time you chose, using the same tools — including any connectors you've linked — that would be available to you in a normal chat. The result is saved as a new conversation, the same as anything else you'd send Friday yourself.",
    ],
  },
  {
    heading: "Payments",
    body: [
      "If you upgrade to a paid plan, payment is handled by Razorpay. We store the order and payment status (amount, plan, and Razorpay's own transaction ID) but we never see or store your card, UPI, or bank details — those go directly to Razorpay.",
    ],
  },
  {
    heading: "Notifications",
    body: [
      "If you enable push notifications (for example, so an automation or a long-running Build Mode task can notify you when it's done even if the app is closed), we store a device token — a Web Push endpoint for the browser, or a Firebase Cloud Messaging token for Android/iOS — tied to your account, solely to deliver that notification.",
    ],
  },
  {
    heading: "Cookies and local storage",
    body: [
      "The Friday web app does not use advertising or tracking cookies. Your sign-in session is kept in your browser's local storage, not a cookie, and is only sent back to our own server. We do not use any third-party analytics, advertising, or tracking service on Friday — nothing here is shared with an ad network.",
    ],
  },
  {
    heading: "Infrastructure",
    body: [
      "Our database and authentication run on Supabase (PostgreSQL). Our servers run on Railway. Redis is used only for short-lived rate-limiting counters (protecting the service from abuse), not to store your messages or personal data. Build Mode's coding sandbox runs on E2B, in an isolated machine created for that project and torn down afterward.",
    ],
  },
  {
    heading: "How long we keep your data",
    body: [
      "We keep your conversations, memory, and account details for as long as your account exists, so Friday keeps working the way you'd expect. If you delete a specific conversation, or a memory, or your whole account, that data is deleted from our active database immediately — see \"Your choices\" below.",
    ],
  },
  {
    heading: "Your choices",
    body: [
      "From Settings, you can: download a full export of your account data and conversations at any time; delete individual conversations or clear all of them; view and delete anything Friday has remembered about you; disconnect any connected account; and permanently delete your Friday account, which deletes your profile, conversations, memory, and connected-account tokens.",
      "If you'd rather we handle a request for you directly — including a request specific to your rights under a law that applies to you, such as the GDPR or India's DPDP Act — email us at " +
        CONTACT_EMAIL +
        " and we'll act on it.",
    ],
  },
  {
    heading: "Children",
    body: [
      "Friday is not directed at children, and you must be at least 13 years old to create an account (or the minimum age required in your country to consent to use of an online service, if that's higher). We do not knowingly collect data from a child under that age; if we learn that we have, we will delete that account.",
    ],
  },
  {
    heading: "Changes to this policy",
    body: [
      `We'll update the date at the top of this page whenever this policy changes. If a change is significant enough that we think you should actively re-agree to it, we'll show you the updated policy again the next time you open Friday, the same way we did the first time.`,
    ],
  },
];

export const TERMS_SECTIONS: LegalSection[] = [
  {
    heading: "Agreement",
    body: [
      `These Terms of Service are an agreement between you and ${COMPANY_NAME} ("Friday", "we", "us") governing your use of the Friday web app, and the Friday apps for Android and iOS. By creating an account or using Friday, you agree to these terms and to our Privacy Policy. If you don't agree, don't use Friday.`,
    ],
  },
  {
    heading: "Who can use Friday",
    body: [
      "You must be at least 13 years old (or the minimum age required in your country to consent to use of an online service, if that's higher) to create a Friday account. You're responsible for keeping your account credentials secure, and for anything that happens through your account.",
    ],
  },
  {
    heading: "AI-generated content",
    body: [
      "Friday's replies, including anything generated by Build Mode, Deep Research, or an automation, are produced by AI models and can be wrong, incomplete, or misleading, even when they sound confident. Don't rely on Friday as your only source for medical, legal, financial, or safety-critical decisions. You're responsible for checking anything important before you act on it.",
      "Code, text, or files Friday generates for you are yours to use. You're responsible for how you use them, including making sure you have the right to use any input you gave Friday (a file you uploaded, a repository you connected, etc.) and complying with any license terms that apply to it.",
    ],
  },
  {
    heading: "Acceptable use",
    body: [
      "Don't use Friday to break the law, to generate content intended to harm someone, to try to extract another user's data, to abuse the service (for example, automated scraping or attempting to overwhelm it), or to reverse-engineer or resell access to Friday itself. Don't use a connector (Gmail, GitHub, etc.) you connect to Friday for anything you wouldn't be allowed to do with that account directly — connecting it to Friday doesn't grant you any access you didn't already have.",
      "We may suspend or terminate an account that violates these terms, or that we reasonably believe is being used to abuse the service or harm others.",
    ],
  },
  {
    heading: "Plans and payment",
    body: [
      "Friday offers a Free plan and paid plans (Pro, and team/business plans), billed through Razorpay. Prices, usage limits, and which models are available on each plan can change — we'll show the current terms on the Plans page before you pay. Paid plans renew automatically until you cancel; cancelling stops the next renewal but doesn't refund the current billing period unless required by law.",
    ],
  },
  {
    heading: "Your content",
    body: [
      "You keep ownership of what you send Friday. By sending it, you give us permission to process it as needed to operate the service — for example, to store it, send it to the AI model provider you chose, and use it to generate the reply you asked for. We don't use your conversations to train our own models, and we don't sell them.",
    ],
  },
  {
    heading: "Third-party services",
    body: [
      "Friday works by calling other companies' services on your behalf — AI model providers, connectors you choose to link, Razorpay for payment, and others described in our Privacy Policy. Your use of those services through Friday is still subject to that provider's own terms. We're not responsible for outages, errors, or policy changes on their end, though we'll do our best to keep Friday working around them.",
    ],
  },
  {
    heading: "No warranty, limitation of liability",
    body: [
      'Friday is provided "as is." We don\'t guarantee it will be uninterrupted, error-free, or that any AI-generated output will be accurate. To the extent allowed by law, we are not liable for indirect, incidental, or consequential damages arising from your use of Friday, and our total liability for any claim is limited to the amount you paid us in the 12 months before the claim, or ₹1,000, whichever is greater.',
    ],
  },
  {
    heading: "Ending your account",
    body: [
      "You can delete your account at any time from Settings; this permanently deletes your conversations, memory, and connected-account tokens. We may suspend or close an account that violates these terms.",
    ],
  },
  {
    heading: "Changes to these terms",
    body: [
      "We'll update the date at the top of this page whenever these terms change, and show you the updated terms again the next time you open Friday if the change is significant.",
    ],
  },
  {
    heading: "Governing law",
    body: [
      `These terms are governed by the laws of India. If you have a dispute with us, contact us at ${CONTACT_EMAIL} first — we'd rather resolve it directly.`,
    ],
  },
];
