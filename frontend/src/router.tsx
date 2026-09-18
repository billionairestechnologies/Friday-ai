import { createRootRoute, createRoute, createRouter, useParams } from "@tanstack/react-router";
import { RootLayout } from "@/routes/__root";
import { Home } from "@/routes/index";
import { AdminGate } from "@/routes/admin";
import { UpgradePage } from "@/routes/upgrade";
import { AppErrorComponent } from "@/lib/error-component";

const rootRoute = createRootRoute({
  component: RootLayout,
  errorComponent: AppErrorComponent,
  notFoundComponent: () => (
    <main className="grid min-h-dvh place-items-center bg-background px-6 text-center text-foreground">
      <div>
        <h1 className="text-xl font-semibold">Page not found</h1>
        <p className="mt-2 text-sm text-muted">That Friday page does not exist.</p>
        <a className="mt-5 inline-flex h-10 items-center rounded-full border border-border px-4 text-sm" href="/">
          Back to chat
        </a>
      </div>
    </main>
  ),
});

// Both routes render the exact same AppShell reference (not two different component
// identities) so navigating between them updates AppShell's conversationId prop in place
// instead of unmounting/remounting Home. A remount here used to abort the very
// streamMessage() fetch that had just been kicked off for a brand-new conversation — Home's
// own unmount cleanup (`abortRef.current?.abort()`) fired mid-request, killing the first
// message of every new chat with a 499 "client closed the request" a few ms in. Sending a
// second message never hit this because ensureConversation only navigates (and only when the
// conversationId actually needs to change) on the very first message of a conversation.
function AppShell() {
  const { conversationId } = useParams({ strict: false }) as { conversationId?: string };
  return <Home conversationId={conversationId} />;
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: AppShell,
});

const conversationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/c/$conversationId",
  component: AppShell,
});

// Hidden, standalone admin gate — not linked from anywhere in the regular app.
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  component: AdminGate,
});

const upgradeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/upgrade",
  component: UpgradePage,
});

const routeTree = rootRoute.addChildren([indexRoute, conversationRoute, adminRoute, upgradeRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
