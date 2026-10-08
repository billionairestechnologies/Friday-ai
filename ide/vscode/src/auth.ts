import * as vscode from "vscode";

/**
 * The extension's own sign-in: the standard OAuth device-code flow (RFC 8628) against the Friday server, the same
 * handshake the CLI uses but with its own client id, so the editor needs no `friday login` and no CLI session.
 * The token is kept in VS Code's SecretStorage (OS keychain), one per server, and handed to the agent through
 * the environment only. It never touches a settings file or the webview.
 */

const CLIENT_ID = "friday-x-vscode";

export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface Account {
  email: string | null;
  name: string | null;
}

export class Auth {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  private key(server: string) {
    return `fridayX.token:${server}`;
  }

  getToken(server: string): Thenable<string | undefined> {
    return this.secrets.get(this.key(server));
  }

  async setToken(server: string, token: string) {
    await this.secrets.store(this.key(server), token);
  }

  async clear(server: string) {
    await this.secrets.delete(this.key(server));
  }

  async start(server: string): Promise<DeviceStart> {
    const res = await fetch(`${server}/api/x/oauth2/device/code`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CLIENT_ID }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`The Friday server didn't start a sign-in (HTTP ${res.status}).`);
    return (await res.json()) as DeviceStart;
  }

  /** Polls until the person approves in the browser. Resolves with the token; rejects on denial, expiry or cancel. */
  async wait(server: string, start: DeviceStart, cancelled: () => boolean): Promise<string> {
    let interval = Math.max(2, start.interval || 5);
    const deadline = Date.now() + Math.min(start.expires_in || 600, 900) * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, interval * 1000));
      if (cancelled()) throw new Error("cancelled");
      const res = await fetch(`${server}/api/x/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: start.device_code,
          client_id: CLIENT_ID,
        }),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
      if (!res) continue; // a network blip must not abort a sign-in the person is in the middle of approving
      const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
      if (res.ok && body.access_token) return body.access_token;
      if (body.error === "slow_down") interval += 5;
      else if (body.error === "access_denied") throw new Error("The sign-in was denied.");
      else if (body.error === "expired_token") throw new Error("The code expired. Try signing in again.");
    }
    throw new Error("The code expired. Try signing in again.");
  }

  /** Who the token belongs to; null when the server rejects it (revoked or expired), which means "sign in again". */
  async whoami(server: string, token: string): Promise<Account | null> {
    const res = await fetch(`${server}/api/x/me`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
    if (!res) return { email: null, name: null }; // offline: keep the token, the agent will report the real problem
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) return { email: null, name: null };
    const body = (await res.json().catch(() => ({}))) as { user?: { email?: string | null; name?: string | null } };
    return { email: body.user?.email ?? null, name: body.user?.name ?? null };
  }

  /** Authenticated GET against /api/x. Null on 401/404/network trouble: every caller treats "no data" as "show nothing". */
  async get<T>(server: string, token: string, path: string): Promise<T | null> {
    const res = await fetch(`${server}/api/x${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
    if (!res?.ok) return null;
    return (await res.json().catch(() => null)) as T | null;
  }

  async post(server: string, token: string, path: string, body: unknown) {
    await fetch(`${server}/api/x${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => undefined);
  }

  /** Revokes the token on the server too, so "sign out" really ends the session. Best effort. */
  async revoke(server: string, token: string) {
    await fetch(`${server}/api/x/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
  }
}
