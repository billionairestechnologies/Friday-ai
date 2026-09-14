export const AUTO_VALUE = "mode:auto";
export const TEAMUP_VALUE = "mode:teamup";

export function isSpecialMode(value: string): "auto" | "teamup" | null {
  if (value === AUTO_VALUE) return "auto";
  if (value === TEAMUP_VALUE) return "teamup";
  return null;
}

export function encodeModelValue(providerSlug: string, modelId: string): string {
  return `${providerSlug}::${modelId}`;
}
