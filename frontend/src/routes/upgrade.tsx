import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { Check, Gift, Sparkles, X } from "lucide-react";
import { api } from "@/lib/api";
import { setAuthIntent } from "@/lib/auth/intent";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { useChat } from "@/lib/chat/store";
import { LoginPopout } from "@/components/popouts";
import {
  formatRupees,
  openCheckout,
  type BillingConfig,
  type CatalogPlan,
  type CheckoutResponse,
  type Entitlements,
  type PublicPackage,
} from "@/lib/billing/checkout";
import type { QuotaResponse, QuotaStatus } from "@/lib/usage/quota";
import { cn } from "@/lib/utils";

/**
 * The Plans page. Everything on it — names, prices, feature bullets, limits, what each plan unlocks,
 * and any special packages — comes from GET /billing/config, which the Team Console edits (Plans &
 * offers → Plans / Packages). Nothing here is hardcoded except the fallback copy for an old server.
 */

type Tier = "free" | "pro" | "premium";

const FALLBACK_FEATURES: Record<CatalogPlan["id"], string[]> = {
  free: ["250K tokens a week", "Chat, search, Canvas and images"],
  pro: ["Everything in Free", "2.5M tokens a week", "Flagship models"],
  premium: ["Everything in Pro", "6.25M tokens a week", "Reasoning and heavy models"],
  enterprise: ["Org-pooled usage, no 5-hour lockout", "Per-member caps", "Every model"],
};

function tokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 2 : 0)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/** The few entitlements worth a chip on a plan card (the full list lives in Settings → Usage). */
function entitlementChips(e: Partial<Entitlements> | undefined): string[] {
  if (!e) return [];
  const chips: string[] = [];
  if (e.buildMode === false) chips.push("No Build Mode");
  else if (e.buildMaxRounds) chips.push(`Build: ${e.buildMaxRounds} rounds/run`);
  if (e.deepResearchPerDay) chips.push(`${e.deepResearchPerDay} Deep Research/day`);
  if (e.documentsPerDay) chips.push(`${e.documentsPerDay} documents/day`);
  if (e.customSkills) chips.push(`${e.customSkills} custom skills`);
  if (e.libraryStorageMb) chips.push(`${e.libraryStorageMb >= 1024 ? `${Math.round(e.libraryStorageMb / 1024)} GB` : `${e.libraryStorageMb} MB`} Library`);
  if (e.teamUpModels) chips.push(`Team Up ×${e.teamUpModels}`);
  if (e.prioritySupport) chips.push("Priority support");
  return chips;
}

function FeatureList({ items }: { items: string[] }) {
  return (
    <ul className="mt-5 flex flex-col gap-2.5">
      {items.map((item) => (
        <li key={item} className="flex items-start gap-2 text-sm text-muted">
          <Check className="mt-0.5 size-4 shrink-0 text-search" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function Chips({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="mt-4 border-t border-border pt-4">
      <p className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">{title}</p>
      <div className="flex flex-wrap gap-1.5">
        {items.map((m) => (
          <span key={m} className="rounded-full bg-chip px-2 py-0.5 text-xs text-foreground">
            {m}
          </span>
        ))}
      </div>
    </div>
  );
}

function PlanCard({
  name,
  tagline,
  badge,
  highlighted,
  price,
  cadence,
  current,
  cta,
  onBuy,
  busy,
  disabled,
  features,
  included,
  models,
  index,
}: {
  name: string;
  tagline?: string;
  badge?: string | null;
  highlighted?: boolean;
  price: string;
  cadence: string;
  current: boolean;
  cta: string;
  onBuy?: () => void;
  busy: boolean;
  disabled: boolean;
  features: string[];
  included?: string[];
  /** Model display names unlocked AT this tier — live from GET /models. */
  models?: string[];
  index: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: index * 0.06, ease: [0.22, 1, 0.36, 1] }}
      className={cn(
        "relative flex w-full flex-col rounded-3xl border bg-elevated p-6",
        highlighted ? "border-search shadow-[var(--shadow-panel)]" : "border-border",
      )}
    >
      {badge && (
        <span className="absolute -top-3 left-6 rounded-full bg-search px-3 py-1 text-[11px] font-semibold tracking-wide text-white uppercase">{badge}</span>
      )}
      <p className="text-xl font-semibold text-foreground">{name}</p>
      {tagline && <p className="mt-1 text-sm text-muted">{tagline}</p>}
      <p className="mt-3 font-mono text-3xl font-semibold text-foreground">
        {price}
        <span className="ml-1 text-sm font-normal text-muted">{cadence}</span>
      </p>
      <button
        type="button"
        disabled={current || disabled}
        onClick={onBuy}
        className={cn(
          "mt-5 h-11 rounded-full text-sm font-semibold transition-opacity disabled:opacity-60",
          current || !onBuy ? "border border-border text-muted" : "bg-primary text-primary-foreground hover:opacity-90",
        )}
      >
        {current ? "Current plan" : busy ? "Starting…" : cta}
      </button>
      <FeatureList items={features} />
      <Chips title="Included" items={included ?? []} />
      <Chips title="Models unlocked" items={models ?? []} />
    </motion.div>
  );
}

export function UpgradePage() {
  const navigate = useNavigate();
  const { user } = useCurrentUserState();
  const signedIn = Boolean(user && !user.isDevFallback);

  const [config, setConfig] = useState<BillingConfig | null>(null);
  const [currentPlan, setCurrentPlan] = useState<QuotaStatus | null>(null);
  const [tab, setTab] = useState<"individual" | "business">("individual");
  const [annual, setAnnual] = useState(false);
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Offer codes (Team Console → Plans & offers): a discount code rides along to checkout (the
  // server re-validates and applies it); plan/pass codes apply immediately.
  const [code, setCode] = useState("");
  const [discount, setDiscount] = useState<{ code: string; percent: number; appliesTo: string[] } | null>(null);
  const [redeeming, setRedeeming] = useState(false);
  const [orgs, setOrgs] = useState<{ id: string; name: string }[]>([]);
  const [orgName, setOrgName] = useState("");
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [seats, setSeats] = useState(3);
  const [modelsByTier, setModelsByTier] = useState<Record<Tier, string[]>>({ free: [], pro: [], premium: [] });

  async function applyCode() {
    if (!code.trim()) return;
    setRedeeming(true);
    setNotice(null);
    try {
      const res = await api.post<{ status: "applied" | "pending" | "discount"; message: string; percent?: number; appliesTo?: string[] }>("/offers/redeem", { code });
      if (res.status === "discount") setDiscount({ code: code.trim(), percent: res.percent ?? 0, appliesTo: res.appliesTo ?? [] });
      else setDiscount(null);
      setNotice(res.message);
    } catch (err) {
      setDiscount(null);
      setNotice(err instanceof Error ? err.message : "That code didn't work");
    } finally {
      setRedeeming(false);
    }
  }
  const offerFor = (planId: string) =>
    discount && (discount.appliesTo.includes(planId) || (planId.startsWith("package:") && discount.appliesTo.includes("packages")))
      ? { offerCode: discount.code }
      : {};

  useEffect(() => {
    // Public endpoint (no auth) — the plan cards show the live model catalog even to a signed-out
    // visitor, and reflect whatever an admin just re-tiered without a code change.
    api
      .get<{ models: { display_name: string; min_tier: Tier }[] }>("/models")
      .then((res) => {
        const grouped: Record<Tier, string[]> = { free: [], pro: [], premium: [] };
        for (const m of res.models) grouped[m.min_tier]?.push(m.display_name);
        setModelsByTier(grouped);
      })
      .catch(() => setModelsByTier({ free: [], pro: [], premium: [] }));
    // Public too — prices must show for a signed-out visitor, and mustn't depend on a maybe-stale token.
    api.get<BillingConfig>("/billing/config").then(setConfig).catch(() => setConfig(null));
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    api
      .get<QuotaResponse>("/usage/quota")
      .then((res) => setCurrentPlan(res.status))
      .catch(() => setCurrentPlan(null));
    api
      .get<{ organizations: { id: string; name: string }[] }>("/organizations")
      .then((res) => {
        setOrgs(res.organizations);
        if (res.organizations[0]) setSelectedOrgId(res.organizations[0].id);
      })
      .catch(() => setOrgs([]));
  }, [signedIn]);

  // Old servers only send individual/enterprise; build the same shape from those.
  const plans: CatalogPlan[] = useMemo(() => {
    if (config?.plans?.length) return config.plans;
    if (!config) return [];
    const legacy = (id: CatalogPlan["id"], name: string, monthly: number, annualPrice: number, tagline: string, minSeats: number | null = null): CatalogPlan => ({
      id, name, tagline, monthlyPricePaise: monthly, annualPricePaise: annualPrice, annualDiscountPercent: config.annualDiscountPercent,
      minSeats, features: FALLBACK_FEATURES[id], badge: null, highlight: id === "pro",
      limits: { weekly: 0, rolling: 0, monthly: null, tokensPerSeat: null }, entitlements: {} as Entitlements,
    });
    const pro = config.individual.find((p) => p.id === "pro");
    const premium = config.individual.find((p) => p.id === "premium");
    return [
      legacy("free", "Free", 0, 0, "Get started"),
      ...(pro ? [legacy("pro", "Pro", pro.monthlyAmountPaise, pro.annualAmountPaise, pro.description)] : []),
      ...(premium ? [legacy("premium", "Premium", premium.monthlyAmountPaise, premium.annualAmountPaise, premium.description)] : []),
      legacy("enterprise", "Enterprise", config.enterprise.perSeatMonthlyAmountPaise, Math.round(config.enterprise.perSeatMonthlyAmountPaise * 12 * 0.9), config.enterprise.description, config.enterprise.minSeats),
    ];
  }, [config]);

  const individual = plans.filter((p) => p.id !== "enterprise");
  const enterprise = plans.find((p) => p.id === "enterprise");
  const packages = (config?.packages ?? []).filter((p) => (tab === "individual" ? p.target === "individual" : p.target === "organization"));
  const minSeats = enterprise?.minSeats ?? 3;
  const enterprisePerSeat = enterprise ? (annual ? enterprise.annualPricePaise : enterprise.monthlyPricePaise) : 0;
  const canPay = Boolean(config?.keyId) && signedIn;
  // A signed-out visitor who taps a plan must land on sign-up/login, not a dead button; they come back here signed in.
  const setDialog = useChat((st) => st.setDialog);
  const openAuth = (intent: "login" | "signup" = "signup") => {
    setAuthIntent(intent);
    setDialog("login");
  };

  async function checkout(key: string, body: Record<string, unknown>) {
    if (!signedIn) return openAuth("signup");
    setBusyPlan(key);
    setNotice(null);
    try {
      const res = await api.post<CheckoutResponse>("/billing/orders", body);
      const failMsg = await openCheckout(res);
      if (failMsg) setNotice(failMsg);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Couldn't start Razorpay checkout");
    } finally {
      setBusyPlan(null);
    }
  }

  const buyPlan = (planId: Tier) => void checkout(planId, { planId, billingCycle: annual ? "annual" : "monthly", ...offerFor(planId) });
  const buyEnterprise = () => {
    if (!signedIn) return openAuth("signup");
    if (!selectedOrgId) return setNotice("Create or select a team first.");
    void checkout("enterprise", { planId: "enterprise", billingCycle: annual ? "annual" : "monthly", seats, organizationId: selectedOrgId, ...offerFor("enterprise") });
  };
  const buyPackage = (pkg: PublicPackage) => {
    if (!signedIn) return openAuth("signup");
    if (pkg.target === "organization" && !selectedOrgId) return setNotice("Create or select a team first.");
    void checkout(`package:${pkg.id}`, {
      planId: "package",
      packageId: pkg.id,
      billingCycle: "monthly",
      ...(pkg.target === "organization" ? { organizationId: selectedOrgId } : {}),
      ...offerFor(`package:${pkg.id}`),
    });
  };

  const isCurrent = (id: CatalogPlan["id"]) =>
    id === "free" ? !currentPlan || (currentPlan.plan === "free" && !currentPlan.isEnterprise) : Boolean(currentPlan?.plan === id && !currentPlan.isEnterprise);

  const teamPicker = (
    <label className="flex flex-col gap-1 text-xs text-muted">
      Team
      {orgs.length > 0 ? (
        <select
          value={selectedOrgId ?? ""}
          onChange={(e) => setSelectedOrgId(e.target.value)}
          className="h-10 rounded-lg border border-border bg-background px-2.5 text-sm text-foreground"
        >
          {orgs.map((org) => (
            <option key={org.id} value={org.id}>
              {org.name}
            </option>
          ))}
        </select>
      ) : (
        <span className="flex gap-2">
          <input
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            placeholder="Team name"
            className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 text-sm text-foreground outline-none"
          />
          <button
            type="button"
            onClick={async () => {
              if (!orgName.trim()) return;
              try {
                const res = await api.post<{ organization: { id: string; name: string } }>("/organizations", { name: orgName });
                setOrgs((prev) => [res.organization, ...prev]);
                setSelectedOrgId(res.organization.id);
                setOrgName("");
              } catch (err) {
                setNotice(err instanceof Error ? err.message : "Couldn't create team");
              }
            }}
            className="h-10 rounded-full border border-border px-3 text-xs font-medium hover:bg-chip"
          >
            Create
          </button>
        </span>
      )}
    </label>
  );

  return (
    <div className="min-h-dvh bg-background px-4 py-10 text-foreground md:px-8">
      <LoginPopout />
      <button
        type="button"
        aria-label="Close"
        onClick={() => void navigate({ to: "/" })}
        className="fixed top-5 right-5 z-10 flex size-9 items-center justify-center rounded-full text-muted hover:bg-chip hover:text-foreground"
      >
        <X className="size-5" />
      </button>

      <div className="mx-auto flex max-w-6xl flex-col items-center">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs text-muted">
          <Sparkles className="size-3.5 text-search" /> Plans & pricing
        </span>
        <h1 className="mt-4 text-center text-3xl font-semibold tracking-tight md:text-4xl">Pick the Friday that fits your work</h1>
        <p className="mt-2 text-center text-sm text-muted">Upgrade, downgrade or add a package anytime. Prices in INR, taxes included.</p>

        <div className="mt-6 flex items-center rounded-full bg-chip p-0.5">
          {(["individual", "business"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn("h-9 rounded-full px-4 text-sm font-medium transition-colors", tab === t ? "bg-background text-foreground" : "text-muted")}
            >
              {t === "individual" ? "Individual" : "Business"}
            </button>
          ))}
        </div>

        <label className="mt-4 flex items-center gap-2 text-sm text-muted">
          Annual
          <button
            type="button"
            role="switch"
            aria-checked={annual}
            onClick={() => setAnnual((v) => !v)}
            className={cn("relative h-5 w-9 rounded-full transition-colors", annual ? "bg-primary" : "bg-chip")}
          >
            <span className={cn("absolute top-0.5 left-0.5 size-4 rounded-full bg-elevated transition-transform", annual && "translate-x-[18px]")} />
          </button>
          <span className={cn("font-medium", annual && "text-foreground")}>Save {plans.find((p) => p.id === "pro")?.annualDiscountPercent ?? config?.annualDiscountPercent ?? 10}%</span>
        </label>

        {signedIn && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void applyCode();
            }}
            className="mt-4 flex flex-wrap items-center justify-center gap-2"
          >
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="Have a code?"
              aria-label="Offer code"
              className="h-9 w-44 rounded-full border border-border bg-background px-4 font-mono text-sm tracking-wider text-foreground outline-none placeholder:font-sans placeholder:tracking-normal placeholder:text-subtle focus:border-foreground/40"
            />
            <button type="submit" disabled={!code.trim() || redeeming} className="h-9 rounded-full border border-border px-4 text-sm font-medium hover:bg-chip disabled:opacity-50">
              {redeeming ? "Checking…" : "Apply"}
            </button>
            {discount && <span className="rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-semibold text-emerald-500">{discount.percent}% off applied</span>}
          </form>
        )}

        {notice && <p className="mt-4 rounded-xl border border-border bg-elevated px-4 py-2 text-sm text-muted">{notice}</p>}
        {!signedIn && <p className="mt-4 rounded-xl border border-border bg-elevated px-4 py-2 text-sm text-muted">Sign up or log in to pick a plan — tap any plan below.</p>}

        {tab === "individual" ? (
          <div className={cn("mt-10 grid w-full gap-5", individual.length >= 3 ? "md:grid-cols-3" : "md:grid-cols-2")}>
            {individual.map((plan, i) => {
              const tier = plan.id as Tier;
              const free = plan.monthlyPricePaise <= 0;
              return (
                <PlanCard
                  key={plan.id}
                  index={i}
                  name={plan.name}
                  tagline={plan.tagline}
                  badge={plan.badge}
                  highlighted={plan.highlight}
                  price={formatRupees(free ? 0 : annual ? plan.annualPricePaise : plan.monthlyPricePaise)}
                  cadence={free ? "/month" : annual ? "/year" : "/month"}
                  current={signedIn && isCurrent(plan.id)}
                  cta={!signedIn ? (free ? "Sign up free" : `Sign up for ${plan.name}`) : free ? "Free forever" : `Upgrade to ${plan.name}`}
                  onBuy={!signedIn ? () => openAuth("signup") : free ? undefined : () => buyPlan(tier)}
                  busy={busyPlan === plan.id}
                  disabled={signedIn && (free || busyPlan !== null || !canPay)}
                  features={plan.features}
                  included={entitlementChips(plan.entitlements)}
                  models={modelsByTier[tier]}
                />
              );
            })}
          </div>
        ) : (
          enterprise && (
            <div className="mt-10 flex w-full flex-col items-center">
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                className="w-full max-w-md rounded-3xl border border-border bg-elevated p-6"
              >
                <p className="text-xl font-semibold text-foreground">{enterprise.name}</p>
                <p className="mt-1 text-sm text-muted">{enterprise.tagline}</p>
                <p className="mt-3 font-mono text-3xl font-semibold text-foreground">
                  {formatRupees(enterprisePerSeat)}
                  <span className="ml-1 text-sm font-normal text-muted">/seat/{annual ? "year" : "month"}</span>
                </p>
                <div className="mt-5 flex flex-col gap-3">
                  {teamPicker}
                  <label className="flex flex-col gap-1 text-xs text-muted">
                    Seats (min {minSeats})
                    <input
                      type="number"
                      min={minSeats}
                      value={seats}
                      onChange={(e) => setSeats(Math.max(minSeats, Number(e.target.value) || minSeats))}
                      className="h-10 rounded-lg border border-border bg-background px-2.5 text-sm text-foreground outline-none"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={signedIn && (busyPlan !== null || !canPay || orgs.length === 0)}
                    onClick={buyEnterprise}
                    className="h-11 rounded-full bg-primary text-sm font-semibold text-primary-foreground disabled:opacity-50"
                  >
                    {busyPlan === "enterprise" ? "Starting…" : `Pay ${formatRupees(enterprisePerSeat * Math.max(seats, minSeats))}`}
                  </button>
                </div>
                <FeatureList items={enterprise.features} />
                <Chips title="Included for every member" items={entitlementChips(enterprise.entitlements)} />
                {enterprise.limits.tokensPerSeat ? (
                  <p className="mt-4 text-xs text-subtle">Pooled usage for every seat, every month.</p>
                ) : null}
              </motion.div>
            </div>
          )
        )}

        {packages.length > 0 && (
          <section className="mt-14 w-full">
            <div className="mb-5 flex items-center gap-2">
              <Gift className="size-4 text-search" />
              <h2 className="text-lg font-semibold">{tab === "individual" ? "Packages & passes" : "Team packages"}</h2>
            </div>
            <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
              {packages.map((pkg, i) => (
                <PlanCard
                  key={pkg.id}
                  index={i}
                  name={pkg.name}
                  tagline={pkg.description}
                  badge={pkg.badge}
                  highlighted={pkg.highlight}
                  price={formatRupees(pkg.pricePaise)}
                  cadence={pkg.durationDays ? ` for ${pkg.durationDays} days` : " one-time"}
                  current={false}
                  cta={signedIn ? "Get this package" : "Sign up to get this"}
                  onBuy={() => buyPackage(pkg)}
                  busy={busyPlan === `package:${pkg.id}`}
                  disabled={signedIn && (busyPlan !== null || !canPay || (pkg.target === "organization" && orgs.length === 0))}
                  features={[
                    ...pkg.features,
                    ...(pkg.monthlyTokenCap ? [`${tokens(pkg.monthlyTokenCap)} tokens a month`] : []),
                    ...(pkg.seats ? [`${pkg.seats} seats`] : []),
                  ]}
                  included={entitlementChips(pkg.entitlements)}
                />
              ))}
            </div>
            {tab === "business" && orgs.length === 0 && <div className="mt-4 max-w-sm">{teamPicker}</div>}
          </section>
        )}

        <ModelPriceList />

        {config && !config.keyId && <p className="mt-6 text-xs text-muted">Razorpay keys are not configured on this environment yet.</p>}
      </div>
    </div>
  );
}

/** Per-model prices (₹ per 1M tokens) for models the team made public in Console → Finance. */
function ModelPriceList() {
  const [prices, setPrices] = useState<{ provider: string; model: string; name: string; inputPerMInr: number; outputPerMInr: number }[]>([]);
  useEffect(() => {
    api
      .get<{ prices: typeof prices }>("/billing/model-prices")
      .then((r) => setPrices(r.prices))
      .catch(() => setPrices([]));
  }, []);
  if (prices.length === 0) return null;
  const rupees = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return (
    <section className="mt-14 w-full">
      <h2 className="text-lg font-semibold">Model prices</h2>
      <p className="mt-1 text-sm text-muted">What each model costs per 1 million tokens (about 750,000 words). Input is what you send, output is what the model writes.</p>
      <div className="mt-4 overflow-x-auto rounded-2xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-surface text-left text-xs text-subtle">
            <tr>
              <th className="px-4 py-2.5 font-medium">Model</th>
              <th className="px-4 py-2.5 text-right font-medium">Input / 1M tokens</th>
              <th className="px-4 py-2.5 text-right font-medium">Output / 1M tokens</th>
            </tr>
          </thead>
          <tbody>
            {prices.map((p) => (
              <tr key={`${p.provider}/${p.model}`} className="border-t border-border">
                <td className="px-4 py-2.5">{p.name}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{rupees(p.inputPerMInr)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{rupees(p.outputPerMInr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
