import { createRootRoute, createRoute, createRouter, useParams } from "@tanstack/react-router";
import { RootLayout } from "@/routes/__root";
import { Home } from "@/routes/index";
import { AdminGate } from "@/routes/admin";
import { UpgradePage } from "@/routes/upgrade";
import { ProjectDetailPage, ProjectsPage } from "@/routes/projects";
import { TeamPage } from "@/routes/team";
import { LibraryPage } from "@/routes/library";
import { AutomationsPage } from "@/routes/automations";
import { SharePage } from "@/routes/share";
import { MobileAuthBridge } from "@/routes/mobile-auth-bridge";
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

const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects",
  component: ProjectsPage,
});

function ProjectDetailRoute() {
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  return <ProjectDetailPage projectId={projectId} />;
}

const projectDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId",
  component: ProjectDetailRoute,
});

const teamRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/team",
  component: TeamPage,
});

const mobileAuthBridgeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mobile-auth-bridge",
  component: MobileAuthBridge,
});

const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library",
  component: LibraryPage,
});

const automationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/automations",
  component: AutomationsPage,
});

function ShareRoute() {
  const { token } = useParams({ strict: false }) as { token: string };
  return <SharePage token={token} />;
}

const shareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/share/$token",
  component: ShareRoute,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  conversationRoute,
  adminRoute,
  upgradeRoute,
  projectsRoute,
  projectDetailRoute,
  teamRoute,
  mobileAuthBridgeRoute,
  libraryRoute,
  automationsRoute,
  shareRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
