import { create } from "zustand";
import { api } from "@/lib/api";

/** The signed-in teammate's console identity and permissions (from GET /api/console/me). */

export type StaffContext = {
  userId: string;
  email: string | null;
  name: string | null;
  roleId: string;
  roleName: string;
  title: string;
  team: string;
  permissions: string[];
  isOwner: boolean;
};

export type PermissionInfo = { id: string; group: string; label: string };

type ConsoleMe = { staff: StaffContext; permissionCatalog: PermissionInfo[]; mailConfigured: boolean };

type State = {
  me: ConsoleMe | null;
  status: "idle" | "loading" | "ready" | "denied" | "error";
  error: string | null;
  load: () => Promise<void>;
  reset: () => void;
};

export const useConsole = create<State>((set) => ({
  me: null,
  status: "idle",
  error: null,
  load: async () => {
    set({ status: "loading", error: null });
    try {
      const me = await api.get<ConsoleMe>("/console/me");
      if (!me?.staff?.permissions) throw new Error("The console API returned an unexpected response");
      set({ me, status: "ready" });
    } catch (err) {
      const status = (err as { status?: number }).status;
      set({ status: status === 403 ? "denied" : "error", error: err instanceof Error ? err.message : "Couldn't open the console" });
    }
  },
  reset: () => set({ me: null, status: "idle", error: null }),
}));

export function hasPermission(granted: readonly string[] | undefined, needed: string): boolean {
  if (!granted) return false;
  if (granted.includes("*") || granted.includes(needed)) return true;
  return granted.includes(`${needed.split(".")[0]}.*`);
}

/** Hook: can the current teammate do this? */
export function useCan(needed: string): boolean {
  return useConsole((s) => hasPermission(s.me?.staff.permissions, needed));
}
