import { useEffect } from "react";
import { Outlet } from "@tanstack/react-router";
import { useChat } from "@/lib/chat/store";
import { currentDirection, currentLocale } from "@/lib/i18n";
import { QuotaAlerts } from "@/components/quota-alerts";
import { ConsentGate } from "@/components/consent-gate";
import { WhatsNewModal } from "@/components/whats-new-modal";

export function RootLayout() {
  const appearance = useChat((s) => s.appearance);

  useEffect(() => {
    document.documentElement.classList.toggle("light", appearance === "light");
    document.documentElement.lang = currentLocale();
    document.documentElement.dir = currentDirection();
  }, [appearance]);

  return (
    <>
      <Outlet />
      <QuotaAlerts />
      <ConsentGate />
      <WhatsNewModal />
    </>
  );
}
