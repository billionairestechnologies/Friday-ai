import { env } from "../../config/env.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { memoAsync } from "../../utils/ttlMemo.js";
import { isPlatform, isVersion, type Platform } from "./installScripts.js";

/**
 * Where Friday X binaries live. CI uploads them to object storage behind a CDN and writes `latest.json`
 * ({"version":"x.y.z"}) last, so a half-uploaded release is never advertised. This server is the only thing
 * the installers and `friday update` talk to: it can pause a bad release (FRIDAY_X_VERSION_PIN) without
 * touching anyone's machine.
 */

export const latestVersion = memoAsync(60_000, async (): Promise<string> => {
  const pinned = process.env.FRIDAY_X_VERSION_PIN?.trim();
  if (pinned && isVersion(pinned)) return pinned;
  if (!env.fridayXReleasesUrl) throw new HttpError(503, "Friday X downloads aren't published yet.");
  const res = await fetch(`${env.fridayXReleasesUrl}/latest.json`, { signal: AbortSignal.timeout(8_000) }).catch(() => null);
  if (!res?.ok) throw new HttpError(503, "Couldn't reach the Friday X release server. Try again in a minute.");
  const version = String(((await res.json().catch(() => ({}))) as { version?: unknown }).version ?? "");
  if (!isVersion(version)) throw new HttpError(503, "Friday X release information is unavailable right now.");
  return version;
}, () => "latest");

export function assetFile(platform: Platform): string {
  return `friday-${platform}${platform.startsWith("windows") ? ".exe" : ""}`;
}

export function assetUrl(platform: string, version: string): string {
  if (!isPlatform(platform)) throw new HttpError(404, "Unknown platform.");
  if (!isVersion(version)) throw new HttpError(400, "Unknown version.");
  if (!env.fridayXReleasesUrl) throw new HttpError(503, "Friday X downloads aren't published yet.");
  return `${env.fridayXReleasesUrl}/v${version}/${assetFile(platform)}`;
}

export async function assetSha256(platform: string, version: string): Promise<string> {
  const res = await fetch(`${assetUrl(platform, version)}.sha256`, { signal: AbortSignal.timeout(8_000) }).catch(() => null);
  if (!res?.ok) throw new HttpError(404, "No checksum is published for that build.");
  const hex = (await res.text()).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new HttpError(502, "The published checksum is malformed.");
  return hex;
}
