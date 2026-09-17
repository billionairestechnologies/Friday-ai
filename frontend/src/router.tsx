import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { RootLayout } from "@/routes/__root";
import { Home } from "@/routes/index";
import { AdminGate } from "@/routes/admin";
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

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Home,
});

const conversationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/c/$conversationId",
  component: ConversationPage,
});

// Hidden, standalone admin gate — not linked from anywhere in the regular app.
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  component: AdminGate,
});

const routeTree = rootRoute.addChildren([indexRoute, conversationRoute, adminRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function ConversationPage() {
  const { conversationId } = conversationRoute.useParams();
  return <Home conversationId={conversationId} />;
}
