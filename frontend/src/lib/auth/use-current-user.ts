import { useAuthStore } from "./client";

/** Normalized user shape the ported UI components expect. */
export type AppUser = {
  id: string;
  displayName: string | null;
  primaryEmail: string | null;
  profileImageUrl: string | null;
  isDevFallback: boolean;
  /** ISO date (YYYY-MM-DD), optional — powers the birthday greeting and age-banded thinking lines. */
  birthday: string | null;
  /** The Privacy Policy/Terms version this account last agreed to — see components/consent-gate.tsx. */
  policyVersion: string | null;
};

export type CurrentUserState = {
  user: AppUser | null;
  isPending: boolean;
};

export function useCurrentUserState(): CurrentUserState {
  const user = useAuthStore((s) => s.user);
  const isPending = useAuthStore((s) => s.isPending);
  return {
    user: user
      ? {
          id: user.id,
          displayName: user.name,
          primaryEmail: user.email,
          profileImageUrl: null,
          isDevFallback: false,
          birthday: user.birthday ?? null,
          policyVersion: user.policyVersion ?? null,
        }
      : null,
    isPending,
  };
}

export function useCurrentUser(): AppUser | null {
  return useCurrentUserState().user;
}
