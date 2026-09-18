import { create } from "zustand";
import { api } from "@/lib/api";
import type { ModelOption } from "@/lib/types";

export type ChatModel = {
  id: string;
  label: string;
  short: string;
  hint: string;
  reasoning: boolean;
  /** Provider slug used to look up a real brand logo. Absent for the Auto/Team Up sentinels. */
  providerSlug?: string;
  /** Human-readable company name, used to group models in the picker. Absent for the Auto/Team Up sentinels. */
  providerName?: string;
  /** Auto/Team Up are always "free" here — the backend already filters which models THEY can
   *  actually use per-message by the viewer's real plan (see chat/index.ts's tier gate); this
   *  field only needs to gate a DIRECT single-model pick in the model picker's lock icon. */
  minTier: "free" | "pro" | "premium";
};

export const AUTO_MODEL_ID = "mode:auto";
export const TEAMUP_MODEL_ID = "mode:teamup";
export const DEFAULT_MODEL_ID = AUTO_MODEL_ID;

export function encodeModelId(providerSlug: string, modelId: string): string {
  return `${providerSlug}::${modelId}`;
}

export function decodeModelId(id: string): { providerSlug: string; modelId: string } | null {
  const idx = id.indexOf("::");
  if (idx === -1) return null;
  return { providerSlug: id.slice(0, idx), modelId: id.slice(idx + 2) };
}

const SPECIAL_MODELS: ChatModel[] = [
  {
    id: AUTO_MODEL_ID,
    label: "Auto",
    short: "Auto",
    hint: "Tries enabled models in order, falls back automatically",
    reasoning: false,
    minTier: "free",
  },
  {
    id: TEAMUP_MODEL_ID,
    label: "Team Up",
    short: "Team",
    hint: "Asks up to 3 models at once and shows every reply",
    reasoning: false,
    minTier: "free",
  },
];

function fromOption(m: ModelOption): ChatModel {
  return {
    id: encodeModelId(m.providers.slug, m.model_id),
    label: m.display_name,
    short: m.display_name,
    hint: m.display_name,
    reasoning: false,
    providerSlug: m.providers.slug,
    providerName: m.providers.display_name,
    minTier: m.min_tier,
  };
}

type ModelsState = {
  models: ChatModel[];
  loaded: boolean;
  load: () => Promise<void>;
};

export const useModels = create<ModelsState>((set, get) => ({
  models: SPECIAL_MODELS,
  loaded: false,
  load: async () => {
    if (get().loaded) return;
    try {
      const res = await api.get<{ models: ModelOption[] }>("/models");
      set({ models: [...SPECIAL_MODELS, ...res.models.map(fromOption)], loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
}));

export function getModel(models: ChatModel[], id: string): ChatModel {
  return models.find((m) => m.id === id) ?? SPECIAL_MODELS[0]!;
}
