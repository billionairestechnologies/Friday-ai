import { type FormEvent, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useAuthStore } from "@/lib/auth/client";

/**
 * Older accounts were created before signup collected a mobile number (and, later, a birthday).
 * This keeps asking — every time the account is missing one of these, not just once — until
 * they're actually filled in and saved, rather than letting them sit blank forever.
 */
export function CompleteProfileModal() {
  const user = useAuthStore((s) => s.user);
  const updateProfile = useAuthStore((s) => s.updateProfile);
  const [phone, setPhone] = useState("");
  const [birthday, setBirthday] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsPhone = Boolean(user && !user.phone);
  const needsBirthday = Boolean(user && !user.birthday);
  const open = needsPhone || needsBirthday;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const patch: { phone?: string; birthday?: string } = {};
      if (needsPhone) patch.phone = phone.trim();
      if (needsBirthday) patch.birthday = birthday;
      await updateProfile(patch);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that — try again");
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = (!needsPhone || phone.trim().length >= 7) && (!needsBirthday || Boolean(birthday));

  return (
    <Dialog.Root open={open}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          onEscapeKeyDown={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          className="fixed top-[50%] left-[50%] z-50 w-[min(92vw,400px)] translate-x-[-50%] translate-y-[-50%] rounded-2xl border border-border bg-elevated p-5 shadow-[var(--shadow-composer)] duration-200 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <Dialog.Title className="text-lg font-semibold tracking-tight text-foreground">
            {needsPhone && needsBirthday
              ? "A couple more details"
              : needsPhone
                ? "Add your mobile number"
                : "Add your birthday"}
          </Dialog.Title>
          <p className="mt-1 mb-4 text-sm leading-relaxed text-muted">
            Your account is missing this — add it to keep using Friday.
          </p>
          <form onSubmit={submit} className="flex flex-col gap-3">
            {needsPhone && (
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="Mobile number"
                required
                autoFocus
                className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-subtle"
              />
            )}
            {needsBirthday && (
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted">Birthday</span>
                <input
                  type="date"
                  value={birthday}
                  onChange={(e) => setBirthday(e.target.value)}
                  required
                  autoFocus={!needsPhone}
                  max={new Date().toISOString().slice(0, 10)}
                  className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none"
                />
              </label>
            )}
            {error && <p className="text-sm text-danger">{error}</p>}
            <button
              type="submit"
              disabled={busy || !canSubmit}
              className="h-11 rounded-full bg-primary text-sm font-semibold text-primary-foreground transition-transform duration-150 hover:opacity-90 active:scale-[0.98] disabled:opacity-60"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
