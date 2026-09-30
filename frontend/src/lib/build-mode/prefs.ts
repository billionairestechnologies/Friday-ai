import { create } from "zustand";

export type BuildEffort = "low" | "medium" | "high";

const KEY = "friday.build.effort";

function readEffort(): BuildEffort {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "low" || v === "high" ? v : "medium";
  } catch {
    return "medium";
  }
}

/** Build workspace composer choices (per browser): how hard the agent works on a build. */
export const useBuildPrefs = create<{ effort: BuildEffort; setEffort: (e: BuildEffort) => void }>((set) => ({
  effort: typeof window === "undefined" ? "medium" : readEffort(),
  setEffort: (effort) => {
    try {
      window.localStorage.setItem(KEY, effort);
    } catch {
      /* private mode etc. — still works for this tab */
    }
    set({ effort });
  },
}));

export const EFFORT_OPTIONS: { id: BuildEffort; label: string; hint: string }[] = [
  { id: "low", label: "Low", hint: "Quick build, fewer checks" },
  { id: "medium", label: "Medium", hint: "Balanced (default)" },
  { id: "high", label: "High", hint: "Extra verification and polish" },
];
