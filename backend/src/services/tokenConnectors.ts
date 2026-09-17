import { HttpError } from "../middleware/errorHandler.js";

export type TokenConnectorId =
  | "notion"
  | "supabase"
  | "railway"
  | "finance"
  | "box"
  | "canva"
  | "razorpay"
  | "vercel";

export type ConnectorField = {
  key: "token" | "secret" | "url";
  label: string;
  secret?: boolean;
  placeholder?: string;
};

export type VerifiedConnector = {
  externalAccountId: string;
  accountLogin: string;
  accountName: string;
  metadata: Record<string, unknown>;
};

export type ConnectorPreviewItem = {
  title: string;
  subtitle?: string | null;
  url?: string | null;
};

type ConnectorInput = {
  token?: string;
  secret?: string;
  url?: string;
};

const TOKEN_MIN = 8;

function requireToken(input: ConnectorInput): string {
  const token = input.token?.trim() ?? "";
  if (token.length < TOKEN_MIN) throw new HttpError(400, "Enter a valid access token");
  return token;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export const TOKEN_CONNECTORS: Record<
  TokenConnectorId,
  {
    pluginIds: string[];
    fields: ConnectorField[];
    verify: (input: ConnectorInput) => Promise<VerifiedConnector>;
    preview: (input: ConnectorInput) => Promise<ConnectorPreviewItem[]>;
  }
> = {
  notion: {
    pluginIds: ["notion"],
    fields: [{ key: "token", label: "Internal integration token", secret: true, placeholder: "ntn_… or secret_…" }],
    verify: async (input) => {
      const token = requireToken(input);
      const response = await fetch("https://api.notion.com/v1/users/me", {
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": "2022-06-28",
        },
      });
      const body = await readJson(response);
      if (!response.ok) throw new HttpError(400, String(body.message ?? "Notion token was rejected"));
      const bot = body as { id?: string; name?: string; bot?: { owner?: { user?: { name?: string } } } };
      const name = bot.name || bot.bot?.owner?.user?.name || "Notion";
      return {
        externalAccountId: bot.id || "notion",
        accountLogin: name,
        accountName: name,
        metadata: {},
      };
    },
    preview: async (input) => {
      const token = requireToken(input);
      const response = await fetch("https://api.notion.com/v1/search", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ page_size: 5 }),
      });
      const body = (await readJson(response)) as {
        results?: Array<{ url?: string; properties?: Record<string, { title?: Array<{ plain_text?: string }> }> }>;
      };
      return (body.results ?? []).map((page, index) => ({
        title:
          page.properties?.title?.title?.[0]?.plain_text ||
          page.properties?.Name?.title?.[0]?.plain_text ||
          `Notion page ${index + 1}`,
        url: page.url ?? null,
      }));
    },
  },
  supabase: {
    pluginIds: ["supabase"],
    fields: [
      { key: "url", label: "Project URL", placeholder: "https://xxxx.supabase.co" },
      { key: "token", label: "Anon or service role key", secret: true },
    ],
    verify: async (input) => {
      const token = requireToken(input);
      const url = (input.url ?? "").replace(/\/$/, "");
      if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url) && !url.startsWith("https://")) {
        throw new HttpError(400, "Enter a valid Supabase project URL");
      }
      const response = await fetch(`${url}/rest/v1/`, {
        headers: { apikey: token, Authorization: `Bearer ${token}` },
      });
      if (!response.ok && response.status !== 200) {
        throw new HttpError(400, "Supabase URL or key was rejected");
      }
      return {
        externalAccountId: url,
        accountLogin: url.replace(/^https:\/\//, ""),
        accountName: "Supabase project",
        metadata: { url },
      };
    },
    preview: async (input) => {
      const token = requireToken(input);
      const url = (input.url ?? "").replace(/\/$/, "");
      const response = await fetch(`${url}/rest/v1/`, {
        headers: { apikey: token, Authorization: `Bearer ${token}`, Accept: "application/openapi+json" },
      });
      if (!response.ok) return [{ title: "Connected", subtitle: url }];
      return [{ title: "REST API reachable", subtitle: url, url }];
    },
  },
  railway: {
    pluginIds: ["railway"],
    fields: [{ key: "token", label: "Railway API token", secret: true }],
    verify: async (input) => {
      const token = requireToken(input);
      const response = await fetch("https://backboard.railway.app/graphql/v2", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: "query { me { id email name } }" }),
      });
      const body = (await readJson(response)) as {
        data?: { me?: { id?: string; email?: string; name?: string | null } };
        errors?: Array<{ message?: string }>;
      };
      const me = body.data?.me;
      if (!response.ok || !me?.id) {
        throw new HttpError(400, body.errors?.[0]?.message ?? "Railway token was rejected");
      }
      return {
        externalAccountId: me.id,
        accountLogin: me.email || me.id,
        accountName: me.name || me.email || "Railway",
        metadata: {},
      };
    },
    preview: async (input) => {
      const token = requireToken(input);
      const response = await fetch("https://backboard.railway.app/graphql/v2", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "query { me { projects { edges { node { id name } } } } }",
        }),
      });
      const body = (await readJson(response)) as {
        data?: { me?: { projects?: { edges?: Array<{ node?: { id?: string; name?: string } }> } } };
      };
      return (body.data?.me?.projects?.edges ?? []).slice(0, 5).map((edge) => ({
        title: edge.node?.name || "Project",
        subtitle: edge.node?.id,
      }));
    },
  },
  vercel: {
    pluginIds: ["vercel"],
    fields: [{ key: "token", label: "Vercel API token", secret: true }],
    verify: async (input) => {
      const token = requireToken(input);
      const response = await fetch("https://api.vercel.com/v2/user", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await readJson(response)) as {
        user?: { id?: string; username?: string; name?: string | null; email?: string };
        error?: { message?: string };
      };
      if (!response.ok || !body.user?.id) {
        throw new HttpError(400, body.error?.message ?? "Vercel token was rejected");
      }
      return {
        externalAccountId: body.user.id,
        accountLogin: body.user.username || body.user.email || body.user.id,
        accountName: body.user.name || body.user.username || "Vercel",
        metadata: {},
      };
    },
    preview: async (input) => {
      const token = requireToken(input);
      const response = await fetch("https://api.vercel.com/v9/projects?limit=5", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await readJson(response)) as {
        projects?: Array<{ name?: string; id?: string; link?: { repo?: string } }>;
      };
      return (body.projects ?? []).map((project) => ({
        title: project.name || "Project",
        subtitle: project.link?.repo || project.id,
      }));
    },
  },
  razorpay: {
    pluginIds: ["razorpay"],
    fields: [
      { key: "token", label: "Key ID", placeholder: "rzp_live_…" },
      { key: "secret", label: "Key secret", secret: true },
    ],
    verify: async (input) => {
      const keyId = requireToken(input);
      const secret = input.secret?.trim() ?? "";
      if (secret.length < TOKEN_MIN) throw new HttpError(400, "Enter the Razorpay key secret");
      const response = await fetch("https://api.razorpay.com/v1/payments?count=1", {
        headers: {
          Authorization: `Basic ${Buffer.from(`${keyId}:${secret}`).toString("base64")}`,
        },
      });
      if (!response.ok) throw new HttpError(400, "Razorpay keys were rejected");
      return {
        externalAccountId: keyId,
        accountLogin: keyId,
        accountName: "Razorpay",
        metadata: {},
      };
    },
    preview: async (input) => {
      const keyId = requireToken(input);
      const secret = input.secret?.trim() ?? "";
      const response = await fetch("https://api.razorpay.com/v1/payments?count=5", {
        headers: {
          Authorization: `Basic ${Buffer.from(`${keyId}:${secret}`).toString("base64")}`,
        },
      });
      const body = (await readJson(response)) as {
        items?: Array<{ id?: string; amount?: number; currency?: string; status?: string }>;
      };
      return (body.items ?? []).map((payment) => ({
        title: payment.id || "Payment",
        subtitle: payment.status
          ? `${payment.status}${payment.amount ? ` · ${payment.amount / 100} ${payment.currency ?? ""}` : ""}`
          : null,
      }));
    },
  },
  box: {
    pluginIds: ["box"],
    fields: [{ key: "token", label: "Box developer token", secret: true }],
    verify: async (input) => {
      const token = requireToken(input);
      const response = await fetch("https://api.box.com/2.0/users/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await readJson(response)) as { id?: string; login?: string; name?: string; message?: string };
      if (!response.ok || !body.id) throw new HttpError(400, body.message ?? "Box token was rejected");
      return {
        externalAccountId: body.id,
        accountLogin: body.login || body.id,
        accountName: body.name || body.login || "Box",
        metadata: {},
      };
    },
    preview: async (input) => {
      const token = requireToken(input);
      const response = await fetch("https://api.box.com/2.0/folders/0/items?limit=5", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await readJson(response)) as { entries?: Array<{ name?: string; type?: string; id?: string }> };
      return (body.entries ?? []).map((entry) => ({
        title: entry.name || entry.id || "Item",
        subtitle: entry.type,
      }));
    },
  },
  canva: {
    pluginIds: ["canva"],
    fields: [{ key: "token", label: "Canva access token", secret: true }],
    verify: async (input) => {
      const token = requireToken(input);
      const response = await fetch("https://api.canva.com/rest/v1/users/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await readJson(response);
      if (!response.ok) throw new HttpError(400, String(body.message ?? "Canva token was rejected"));
      const teamUser = body as { team_user?: { user_id?: string; display_name?: string } };
      const id = teamUser.team_user?.user_id || "canva";
      const name = teamUser.team_user?.display_name || "Canva";
      return { externalAccountId: id, accountLogin: name, accountName: name, metadata: {} };
    },
    preview: async () => [{ title: "Canva connected", subtitle: "Designs are available through this token" }],
  },
  finance: {
    pluginIds: ["finance"],
    fields: [{ key: "token", label: "Finance API token", secret: true }],
    verify: async (input) => {
      const token = requireToken(input);
      return {
        externalAccountId: `finance:${token.slice(-6)}`,
        accountLogin: "finance",
        accountName: "Finance account",
        metadata: {},
      };
    },
    preview: async () => [{ title: "Finance connected", subtitle: "Token stored encrypted for later account pulls" }],
  },
};

export function isTokenConnector(provider: string): provider is TokenConnectorId {
  return provider in TOKEN_CONNECTORS;
}
