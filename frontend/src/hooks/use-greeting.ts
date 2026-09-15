import { useEffect, useState } from "react";

function greetingForHour(hour: number): string {
  if (hour < 5) return "Good night";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  if (hour < 21) return "Good evening";
  return "Good night";
}

export function useGreeting(): string {
  const [greeting, setGreeting] = useState(() => greetingForHour(new Date().getHours()));

  useEffect(() => {
    const id = window.setInterval(() => {
      setGreeting(greetingForHour(new Date().getHours()));
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);

  return greeting;
}
