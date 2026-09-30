/**
 * "Open in Build" from a normal chat: the request is parked here, the app navigates to /build, and the
 * Build workspace sends it as the first message of a fresh build session. A module-level slot rather
 * than the store's draft because entering the workspace resets the draft (Home's workspace effect).
 */
let pending: string | null = null;

export function handOffToBuild(prompt: string) {
  pending = prompt.trim() || null;
}

/** Returns the parked prompt once (null afterwards). */
export function takeBuildHandoff(): string | null {
  const p = pending;
  pending = null;
  return p;
}
