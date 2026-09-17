const RTL_LANGUAGES = new Set(["ar", "fa", "he", "ur"]);

export function currentLocale(): string {
  if (typeof navigator === "undefined") return "en";
  return navigator.languages?.[0] || navigator.language || "en";
}

export function currentDirection(locale = currentLocale()): "ltr" | "rtl" {
  const language = locale.split("-")[0]?.toLowerCase() ?? "en";
  return RTL_LANGUAGES.has(language) ? "rtl" : "ltr";
}

export function formatLocalTime(ts: number, locale = currentLocale()): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
  }).format(ts);
}
