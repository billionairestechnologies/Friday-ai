import { createApp } from "./app.js";
import { env } from "./config/env.js";

// A single stray unhandled rejection anywhere (a provider adapter, a background task) otherwise
// crashes this whole process by default on Node 15+ — taking down every other in-flight
// request/SSE stream with it. Confirmed live: a slow ScaleMax response rejecting after
// withTimeout's race had already settled did exactly this. Log and keep running instead; the
// promise's own call site should still surface a proper error to whoever awaited it.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection (process kept alive):", reason);
});

const app = createApp();

app.listen(env.port, () => {
  console.log(`Friday AI backend listening on http://localhost:${env.port}`);
});
