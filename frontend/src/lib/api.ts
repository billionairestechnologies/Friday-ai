const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";

let accessToken: string | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export const API_BASE_URL = API_BASE;

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// The access token is a short-lived JWT (~1hr) — a tab left open longer than that would
// otherwise start throwing "missing/invalid token" on every request. auth/client.ts registers
// a handler here (rather than this module importing the auth store directly, which would be
// circular) that tries to refresh the session; on success the request below is retried once.
let unauthorizedHandler: (() => Promise<boolean>) | null = null;

export function setUnauthorizedHandler(fn: (() => Promise<boolean>) | null) {
  unauthorizedHandler = fn;
}

async function request<T>(path: string, options: RequestInit = {}, isRetry = false): Promise<T> {
  const headers: Record<string, string> = { ...(options.headers as Record<string, string>) };
  if (!(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (res.status === 401 && !isRetry && unauthorizedHandler) {
    const refreshed = await unauthorizedHandler();
    if (refreshed) return request<T>(path, options, true);
  }

  if (res.status === 204) return undefined as T;

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    // The backend answers { error: "text" }, but a proxy / gateway error (502, 503…) comes back as some
    // other JSON shape — String() of that was the "[object Object]" banner. Take a readable string, else
    // a plain sentence for the status.
    const fromBody =
      isJson && body && typeof body === "object"
        ? [(body as { error?: unknown }).error, (body as { message?: unknown }).message].find((v): v is string => typeof v === "string" && v.length > 0)
        : typeof body === "string"
          ? body.trim()
          : "";
    const gateway = res.status === 502 || res.status === 503 || res.status === 504;
    const message = gateway ? "Can't reach Friday right now — check your connection and try again in a moment." : fromBody;
    throw new ApiError(res.status, message || `Request failed: ${res.status}`);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: "POST", body: data instanceof FormData ? data : JSON.stringify(data ?? {}) }),
  patch: <T>(path: string, data?: unknown) => request<T>(path, { method: "PATCH", body: JSON.stringify(data ?? {}) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
