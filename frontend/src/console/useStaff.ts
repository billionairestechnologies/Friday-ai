import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export type StaffOption = { userId: string; name: string; email: string | null; roleName: string };

let cache: StaffOption[] | null = null;
let inflight: Promise<StaffOption[]> | null = null;

/** Teammates for assignee pickers (any staff member can read this list). */
export function useStaffOptions(): StaffOption[] {
  const [list, setList] = useState<StaffOption[]>(cache ?? []);
  useEffect(() => {
    if (cache) return;
    inflight ??= api.get<{ staff: StaffOption[] }>("/console/staff").then((r) => (cache = r.staff));
    inflight.then(setList).catch(() => {
      inflight = null;
    });
  }, []);
  return list;
}
