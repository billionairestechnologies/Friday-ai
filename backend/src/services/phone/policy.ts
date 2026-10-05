/** Phone is a surface on Friday. These rules decide the call. They do not run a second assistant. */

export type DeliveryChannel = "call" | "app" | "telegram" | "whatsapp" | "email";

export type PhoneConfig = {
  enabledPlanIds: string[];
  inrPerMinute: number;
  includedMinutes: number;
  hardCapMinutes: number;
  maxHeldSeconds: number;
  /** Gemini Live speaks first. Sarvam is the switch for the Indian voice. */
  voice: "gemini" | "sarvam";
  channels: { telegram: boolean; whatsapp: boolean; email: boolean };
};

export type UserPhoneSettings = {
  channels: DeliveryChannel[];
  callback: boolean;
  quietStart: string | null;
  quietEnd: string | null;
  language: string;
};

export const DEFAULT_PHONE_CONFIG: PhoneConfig = {
  enabledPlanIds: ["premium"],
  inrPerMinute: 4,
  includedMinutes: 60,
  hardCapMinutes: 60,
  maxHeldSeconds: 10,
  voice: "gemini",
  channels: { telegram: true, whatsapp: false, email: true },
};

export const DEFAULT_USER_PHONE_SETTINGS: UserPhoneSettings = {
  channels: ["app", "email"],
  callback: false,
  quietStart: null,
  quietEnd: null,
  language: "en",
};

export const PHONE_BEHAVIOR = [
  "You are Friday, on a phone call. One turn. Answer, then stop and wait.",
  "Do not interview. Ask one question only when the job is actually ambiguous, then wait.",
  "Do not fill silence. Do not keep talking after the answer.",
  "Short work: do it and say the result in a sentence or two.",
  "Sending, deleting, or paying needs a spoken yes and their passphrase. Otherwise refuse.",
].join(" ");

export const UNKNOWN_CALLER = "This number isn't on a Friday account.";

const LONG_WORK =
  /\b(research|look into|deep dive|build|create|make|code|sandbox|app|website|loop|agent|workflow|automate|every morning|every day|schedule|presentation|document)\b/i;
const STAY = /\b(stay with me|stay on the line|don't hang up|dont hang up|keep the line|hold the line)\b/i;
const MACHINE = /\b(on my (machine|computer|laptop)|on the (cli|terminal))\b/i;
const SANDBOX = /\b(in the sandbox|sandbox)\b/i;
const SENSITIVE = /\b(pay|send|delete|transfer|purchase)\b/i;
const YES = /\byes\b/i;

export type TurnDecision = {
  action: "hangup" | "speak" | "hold" | "release";
  speak: string;
  hold: boolean;
  longWork: boolean;
  research: boolean;
  build: boolean;
  delivery: DeliveryChannel[];
  callback: boolean;
};

export function planAllowsPhone(plan: string, config: PhoneConfig): boolean {
  return config.enabledPlanIds.includes(plan);
}

export function minutesLeft(usedSeconds: number, config: PhoneConfig): number {
  const used = usedSeconds / 60;
  return Math.max(0, config.hardCapMinutes - used);
}

export function inrForSeconds(seconds: number, config: PhoneConfig): number {
  const over = Math.max(0, seconds - config.includedMinutes * 60);
  return Math.round((over / 60) * config.inrPerMinute * 100) / 100;
}

function quietNow(settings: UserPhoneSettings, now: Date): boolean {
  if (!settings.quietStart || !settings.quietEnd) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  const toMins = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map((n) => Number(n));
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return h * 60 + m;
  };
  const start = toMins(settings.quietStart);
  const end = toMins(settings.quietEnd);
  if (start == null || end == null) return false;
  if (start <= end) return mins >= start && mins < end;
  return mins >= start || mins < end;
}

export function spokenDelivery(text: string, settings: UserPhoneSettings, config: PhoneConfig): DeliveryChannel[] {
  const asked = new Set<DeliveryChannel>();
  if (/\b(on the call|tell me|say it)\b/i.test(text)) asked.add("call");
  if (/\b(in the app|on the app)\b/i.test(text)) asked.add("app");
  if (/\btelegram\b/i.test(text)) asked.add("telegram");
  if (/\bwhatsapp\b/i.test(text)) asked.add("whatsapp");
  if (/\bemail\b/i.test(text) || /\bmail\b/i.test(text)) asked.add("email");
  const chosen = asked.size > 0 ? [...asked] : settings.channels.filter((c) => c !== "call");
  const open = chosen.filter((c) => {
    if (c === "telegram") return config.channels.telegram;
    if (c === "whatsapp") return config.channels.whatsapp;
    if (c === "email") return config.channels.email;
    return true;
  });
  if (!open.includes("app")) open.unshift("app");
  if (!open.includes("call")) open.unshift("call");
  return open;
}

export function decideTurn(input: {
  knownUser: boolean;
  plan: string;
  usedSeconds: number;
  text: string;
  config: PhoneConfig;
  settings: UserPhoneSettings;
  machineOnline: boolean;
  now?: Date;
}): TurnDecision {
  const now = input.now ?? new Date();
  const delivery = spokenDelivery(input.text, input.settings, input.config);
  const base = { delivery, callback: input.settings.callback, research: false, build: false, longWork: false, hold: false };

  if (!input.knownUser) return { ...base, action: "hangup", speak: UNKNOWN_CALLER };
  if (!planAllowsPhone(input.plan, input.config)) {
    return { ...base, action: "hangup", speak: "Phone is on Premium. You can change that in admin." };
  }
  if (minutesLeft(input.usedSeconds, input.config) <= 0) {
    return { ...base, action: "hangup", speak: "You've used this month's call minutes." };
  }
  if (quietNow(input.settings, now) && !/\burgent\b/i.test(input.text)) {
    return { ...base, action: "hangup", speak: "Friday is quiet right now. Say it's urgent if it can't wait." };
  }
  if (SENSITIVE.test(input.text) && !YES.test(input.text)) {
    return { ...base, action: "speak", speak: "Say yes, then your passphrase, and I'll do that." };
  }
  if (MACHINE.test(input.text) && !input.machineOnline) {
    return { ...base, action: "speak", speak: "Your computer isn't connected. I can do it in the sandbox instead." };
  }

  const longWork = LONG_WORK.test(input.text);
  const stay = STAY.test(input.text);
  const research = /\b(research|look into|deep dive)\b/i.test(input.text);
  const build = /\b(build|create|make|code|app|website|sandbox)\b/i.test(input.text) || SANDBOX.test(input.text);
  const where = delivery.filter((c) => c !== "call").join(" and ") || "the app";

  if (longWork && !stay) {
    return {
      ...base,
      action: "release",
      speak: `I'm starting that. I'll put it in ${where}, then hang up so the minutes don't run.`,
      longWork: true,
      research,
      build,
      hold: false,
      callback: input.settings.callback,
    };
  }

  return {
    ...base,
    action: "hold",
    speak: "",
    longWork,
    research,
    build,
    hold: true,
  };
}

export function overrunSpeech(delivery: DeliveryChannel[]): string {
  const where = delivery.filter((c) => c !== "call").join(" and ") || "the app";
  return `This is taking longer than a few seconds. I'll finish it off the line and put it in ${where}.`;
}
