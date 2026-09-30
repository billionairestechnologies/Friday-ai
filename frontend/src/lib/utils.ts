import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { formatLocalTime } from "@/lib/i18n";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function uid() {
  // randomUUID only exists in secure contexts (HTTPS/localhost). On the plain-HTTP test server
  // (bare EC2 IP) it's undefined and every chat action threw "crypto.randomUUID is not a function",
  // so build the same v4 UUID from getRandomValues, which works everywhere.
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function formatTime(ts: number) {
  return formatLocalTime(ts);
}
