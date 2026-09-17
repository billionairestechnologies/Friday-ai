import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { formatLocalTime } from "@/lib/i18n";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function uid() {
  return crypto.randomUUID();
}

export function formatTime(ts: number) {
  return formatLocalTime(ts);
}
