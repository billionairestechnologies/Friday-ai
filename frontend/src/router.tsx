import { createRootRoute, createRoute, createRouter, useParams } from "@tanstack/react-router";
import { RootLayout } from "@/routes/__root";
import { Home } from "@/routes/index";
import { lazy, Suspense } from "react";
import { UpgradePage } from "@/routes/upgrade";
import { ProjectDetailPage, ProjectsPage } from "@/routes/projects";
import { TeamPage } from "@/routes/team";
import { LibraryPage } from "@/routes/library";
import { AutomationsPage } from "@/routes/automations";
import { SharePage } from "@/routes/share";
import { MobileAuthBridge } from "@/routes/mobile-auth-bridge";
import { AppErrorComponent } from "@/lib/error-component";
import { SitePage } from "@/routes/site";
import { PrivacyPage, TermsPage } from "@/routes/legal";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

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

// The Build workspace (like Claude Code): the same chat engine in build mode — build-only history,
// every message goes to the Build agent, the project workspace (preview/files/terminal) docked on
// the right. One shared component for both routes, for the same no-remount reason as AppShell.
// Signed-out visitors (and search crawlers) on bare /build keep the public product page; signed-in
// users get the workspace.
function BuildShell() {
  const { conversationId } = useParams({ strict: false }) as { conversationId?: string };
  const { user, isPending } = useCurrentUserState();
  const signedIn = Boolean(user && !user.isDevFallback);
  if (!conversationId && !signedIn) return isPending ? null : <SitePage slug="build" />;
  return <Home conversationId={conversationId} workspace="build" />;
}

const buildRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/build",
  component: BuildShell,
});

const buildConversationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/build/$conversationId",
  component: BuildShell,
});

// The Team Console (company back office) — hidden, standalone, not linked from the regular app.
// Code-split: none of it ships in the chat app's bundle.
const ConsoleApp = lazy(() => import("@/console/ConsoleApp").then((m) => ({ default: m.ConsoleApp })));

function ConsoleRoute() {
  const { section } = useParams({ strict: false }) as { section?: string };
  return (
    <Suspense fallback={<div className="h-dvh bg-background" />}>
      <ConsoleApp section={section} />
    </Suspense>
  );
}

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  component: ConsoleRoute,
});

const adminSectionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/$section",
  component: ConsoleRoute,
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

// Signed-out visitors (and search crawlers) get the public Automations page; signed-in users the app.
function AutomationsRoute() {
  const { user, isPending } = useCurrentUserState();
  if (isPending) return null;
  return user && !user.isDevFallback ? <AutomationsPage /> : <SitePage slug="automations" />;
}

const automationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/automations",
  component: AutomationsRoute,
});

// Public product pages — the titles/descriptions Google indexes come from backend/src/seo.ts.
const siteRoutes = (["overview", "models", "research", "connectors"] as const).map((slug) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path: `/${slug}`,
    component: () => <SitePage slug={slug} />,
  }),
);

const plansRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/plans",
  component: UpgradePage,
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

const privacyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/privacy",
  component: PrivacyPage,
});

const termsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/terms",
  component: TermsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  conversationRoute,
  buildRoute,
  buildConversationRoute,
  adminRoute,
  adminSectionRoute,
  upgradeRoute,
  projectsRoute,
  projectDetailRoute,
  teamRoute,
  mobileAuthBridgeRoute,
  libraryRoute,
  automationsRoute,
  shareRoute,
  plansRoute,
  privacyRoute,
  termsRoute,
  ...siteRoutes,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
