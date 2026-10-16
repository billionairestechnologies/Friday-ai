/** Unambiguous "build me an app" asks open Build Mode. Everything else stays a chat. Same pool either way. */
const CLEAR_BUILD =
  /\b(build|create|make|develop|generate|scaffold|code|design|set ?up)\b[^.?!\n]{0,60}\b(app|apps|website|web ?site|web ?app|webpage|landing page|dashboard|full[- ]?stack|saas|backend|back-end|rest api|api server|crm|portfolio|platform|mvp|clone|game|admin panel|e-?commerce|storefront)\b/i;

export function airWorkspace(task: string): "chat" | "build" {
  return CLEAR_BUILD.test(task) ? "build" : "chat";
}

export function isAirStop(text: string): boolean {
  return /^(rukho|ruko|stop)$/i.test(text.trim());
}
