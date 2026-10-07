/**
 * Where an OAuth sign-in lands afterwards. Only a same-site path is allowed: the callback appends the session to the
 * URL hash, so an absolute or protocol-relative value would hand the login to another site. `/device?code=…` must
 * survive the round trip or `friday login` ends on the dashboard instead of the approval page.
 */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== "string") return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\") || /[\r\n]/.test(value)) return "/";
  return value.slice(0, 500);
}
