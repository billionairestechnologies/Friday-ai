import { useEffect } from "react";
import { Outlet } from "@tanstack/react-router";
import { useChat } from "@/lib/chat/store";

export function RootLayout() {
  const appearance = useChat((s) => s.appearance);

  useEffect(() => {
    document.documentElement.classList.toggle("light", appearance === "light");
  }, [appearance]);

  return <Outlet />;
}
