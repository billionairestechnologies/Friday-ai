import "dotenv/config";
import { supabaseAdmin } from "./src/config/supabase.js";
import { streamMessage } from "./src/services/chat/index.js";
import { Sandbox } from "@e2b/code-interpreter";
const USER = "a393ed2f-8af2-4744-a1b6-d8d1f859da6a";
const { data: conv } = await supabaseAdmin.from("conversations").insert({ user_id: USER, mode: "auto", title: "e2e visual" }).select().single();
const t0 = Date.now();
let url = "";
try {
  await streamMessage(USER, conv!.id, "make a high end full stack website for Billionaires Technologies with react, tailwind, express, login and register", "text", (ev) => {
    const t = Math.round((Date.now() - t0) / 1000);
    if (ev.t === "step" && ev.state !== "running") console.log(`${t}s [${ev.state}] ${ev.kind}: ${ev.label.slice(0, 110)}${ev.state === "error" && ev.detail ? " :: " + ev.detail.slice(0, 260).replace(/\n/g, " ⏎ ") : ""}`);
    if (ev.t === "preview") { url = ev.url; console.log("PREVIEW", ev.url); }
    if (ev.t === "text") process.stdout.write("[final text] " + ev.c.slice(0, 300) + "\n");
    if (ev.t === "err") console.log("ERR", ev.c);
  });
  console.log("elapsed", Math.round((Date.now() - t0) / 1000), "s | preview:", url);
  const { data: proj } = await supabaseAdmin.from("build_projects").select("sandbox_id").eq("conversation_id", conv!.id).single();
  console.log("SANDBOX_URL=" + url);
  // keep sandbox alive for screenshot by the caller; write url to file
  (await import("fs")).writeFileSync("/tmp/last-preview.txt", url + "\n" + (proj?.sandbox_id ?? ""));
} catch (e) { console.log("failed", e); }
// cleanup conversation later
(await import("fs")).writeFileSync("/tmp/last-conv.txt", conv!.id);
