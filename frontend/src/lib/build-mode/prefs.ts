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

export type PermissionMode = "ask" | "auto_edit" | "full_auto";
const MODE_KEY = "friday.build.permissionMode";

function readMode(): PermissionMode {
  try {
    const v = window.localStorage.getItem(MODE_KEY);
    return v === "ask" || v === "auto_edit" ? v : "full_auto";
  } catch {
    return "full_auto";
  }
}

function save(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode etc. — still works for this tab */
  }
}

/** Build workspace composer choices (per browser): how hard the agent works, and what it may do
 *  without asking. */
export const useBuildPrefs = create<{
  effort: BuildEffort;
  setEffort: (e: BuildEffort) => void;
  permissionMode: PermissionMode;
  setPermissionMode: (m: PermissionMode) => void;
}>((set) => ({
  effort: typeof window === "undefined" ? "medium" : readEffort(),
  setEffort: (effort) => {
    save(KEY, effort);
    set({ effort });
  },
  permissionMode: typeof window === "undefined" ? "full_auto" : readMode(),
  setPermissionMode: (permissionMode) => {
    save(MODE_KEY, permissionMode);
    set({ permissionMode });
  },
}));

export const PERMISSION_OPTIONS: { id: PermissionMode; label: string; hint: string }[] = [
  { id: "full_auto", label: "Full auto", hint: "Runs everything in the sandbox without asking" },
  { id: "auto_edit", label: "Auto-edit", hint: "Edits files freely, asks before commands" },
  { id: "ask", label: "Ask every time", hint: "Asks before every change and command" },
];

export const EFFORT_OPTIONS: { id: BuildEffort; label: string; hint: string }[] = [
  { id: "low", label: "Low", hint: "Quick build, fewer checks" },
  { id: "medium", label: "Medium", hint: "Balanced (default)" },
  { id: "high", label: "High", hint: "Extra verification and polish" },
];
