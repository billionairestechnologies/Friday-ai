import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Check, X } from "lucide-react";
import { api } from "@/lib/api";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import {
  amountForCyclePreview,
  formatRupees,
  openCheckout,
  type BillingConfig,
  type CheckoutResponse,
} from "@/lib/billing/checkout";
import type { QuotaResponse, QuotaStatus } from "@/lib/usage/quota";
import { cn } from "@/lib/utils";

const FREE_FEATURES = [
  "250,000 tokens/week",
  "50,000 tokens per 5-hour burst",
  "Lightweight models",
  "Chat, Search, Canvas preview",
];

const PRO_FEATURES = [
  "Everything in Free",
  "2.5M tokens/week (10M/month)",
  "500,000 tokens per 5-hour burst",
  "Flagship models unlocked",
  "Higher concurrency",
];

const PREMIUM_FEATURES = [
  "Everything in Pro",
  "6.25M tokens/week (25M/month)",
  "1.2M tokens per 5-hour burst",
  "Reasoning & heavy models unlocked",
  "Highest concurrency",
];

const ENTERPRISE_FEATURES = [
  "Org-pooled tokens, no 5-hour lockout",
  "Per-member caps set by your own admin",
  "Every model, priority handling",
  "Centralized billing across your team",
  "Add or remove seats anytime",
];

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

function PlanCard({
  name,
  highlighted,
  price,
  cadence,
  current,
  cta,
  onBuy,
  busy,
  disabled,
  features,
  models,
}: {
  name: string;
  highlighted?: boolean;
  price: string;
  cadence: string;
  current: boolean;
  cta: string;
  onBuy?: () => void;
  busy: boolean;
  disabled: boolean;
  features: string[];
  /** Model display names unlocked AT this tier specifically — sourced live from GET /models,
   *  so an admin re-tiering a model in the provider panel shows up here without a code change. */
  models?: string[];
}) {
  return (
    <div
      className={cn(
        "flex w-full max-w-sm flex-col rounded-3xl border bg-elevated p-6",
        highlighted ? "border-search shadow-[var(--shadow-panel)]" : "border-border",
      )}
    >
      <p className="text-xl font-semibold text-foreground">{name}</p>
      <p className="mt-3 font-mono text-3xl font-semibold text-foreground">
        {price}
        <span className="ml-1 text-sm font-normal text-muted">{cadence}</span>
      </p>
      <button
        type="button"
        disabled={current || disabled}
        onClick={onBuy}
        className={cn(
          "mt-5 h-11 rounded-full text-sm font-semibold disabled:opacity-60",
          current
            ? "border border-border text-muted"
            : "bg-primary text-primary-foreground hover:opacity-90",
        )}
      >
        {current ? "Current Plan" : busy ? "Starting…" : cta}
      </button>
      <FeatureList items={features} />
      {models && models.length > 0 && (
        <div className="mt-4 border-t border-border pt-4">
          <p className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">Models unlocked</p>
          <div className="flex flex-wrap gap-1.5">
            {models.map((m) => (
              <span key={m} className="rounded-full bg-chip px-2 py-0.5 text-xs text-foreground">
                {m}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
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
  const [orgs, setOrgs] = useState<{ id: string; name: string }[]>([]);
  const [orgName, setOrgName] = useState("");
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [seats, setSeats] = useState(3);
  const [modelsByTier, setModelsByTier] = useState<Record<"free" | "pro" | "premium", string[]>>({
    free: [],
    pro: [],
    premium: [],
  });

  useEffect(() => {
    // Public endpoint (no auth) — the plan cards should show the live model catalog even to a
    // signed-out visitor, and it reflects whatever an admin just re-tiered without a code change.
    api
      .get<{ models: { display_name: string; min_tier: "free" | "pro" | "premium" }[] }>("/models")
      .then((res) => {
        const grouped: Record<"free" | "pro" | "premium", string[]> = { free: [], pro: [], premium: [] };
        for (const m of res.models) grouped[m.min_tier].push(m.display_name);
        setModelsByTier(grouped);
      })
      .catch(() => setModelsByTier({ free: [], pro: [], premium: [] }));
  }, []);

  // Public, same as /models above — prices must show for a signed-out visitor too, and mustn't
  // ever depend on a maybe-stale session token the way the account-specific calls below do.
  useEffect(() => {
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

  async function createOrgInline() {
    if (!orgName.trim()) return;
    try {
      const res = await api.post<{ organization: { id: string; name: string } }>("/organizations", { name: orgName });
      setOrgs((prev) => [res.organization, ...prev]);
      setSelectedOrgId(res.organization.id);
      setOrgName("");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Couldn't create team");
    }
  }

  async function buyIndividual(planId: "pro" | "premium") {
    setBusyPlan(planId);
    setNotice(null);
    try {
      const res = await api.post<CheckoutResponse>("/billing/orders", {
        planId,
        billingCycle: annual ? "annual" : "monthly",
      });
      const failMsg = await openCheckout(res);
      if (failMsg) setNotice(failMsg);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Couldn't start Razorpay checkout");
    } finally {
      setBusyPlan(null);
    }
  }

  async function buyEnterprise() {
    if (!selectedOrgId) {
      setNotice("Create or select a team first.");
      return;
    }
    setBusyPlan("enterprise");
    setNotice(null);
    try {
      const res = await api.post<CheckoutResponse>("/billing/orders", {
        planId: "enterprise",
        billingCycle: annual ? "annual" : "monthly",
        seats,
        organizationId: selectedOrgId,
      });
      const failMsg = await openCheckout(res);
      if (failMsg) setNotice(failMsg);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Couldn't start Razorpay checkout");
    } finally {
      setBusyPlan(null);
    }
  }

  const minSeats = config?.enterprise.minSeats ?? 3;
  const pro = config?.individual.find((p) => p.id === "pro");
  const premium = config?.individual.find((p) => p.id === "premium");
  const enterprisePerSeat = config
    ? amountForCyclePreview(config.enterprise.perSeatMonthlyAmountPaise, annual)
    : 0;

  return (
    <div className="min-h-dvh bg-background px-4 py-10 text-foreground md:px-8">
      <button
        type="button"
        aria-label="Close"
        onClick={() => void navigate({ to: "/" })}
        className="fixed top-5 right-5 z-10 flex size-9 items-center justify-center rounded-full text-muted hover:bg-chip hover:text-foreground"
      >
        <X className="size-5" />
      </button>

      <div className="mx-auto flex max-w-5xl flex-col items-center">
        <h1 className="text-2xl font-bold tracking-tight">Friday</h1>
        <p className="mt-2 text-2xl font-semibold text-foreground">Manage your subscription</p>

        <div className="mt-6 flex items-center rounded-full bg-chip p-0.5">
          <button
            type="button"
            onClick={() => setTab("individual")}
            className={cn("h-9 rounded-full px-4 text-sm font-medium", tab === "individual" ? "bg-background text-foreground" : "text-muted")}
          >
            Individual
          </button>
          <button
            type="button"
            onClick={() => setTab("business")}
            className={cn("h-9 rounded-full px-4 text-sm font-medium", tab === "business" ? "bg-background text-foreground" : "text-muted")}
          >
            Business
          </button>
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
            <span
              className={cn(
                "absolute top-0.5 left-0.5 size-4 rounded-full bg-elevated transition-transform",
                annual && "translate-x-[18px]",
              )}
            />
          </button>
          <span className={cn("font-medium", annual && "text-foreground")}>
            Save {config?.annualDiscountPercent ?? 10}%
          </span>
        </label>

        {notice && (
          <p className="mt-4 rounded-xl border border-border bg-elevated px-4 py-2 text-sm text-muted">{notice}</p>
        )}
        {!signedIn && (
          <p className="mt-4 rounded-xl border border-border bg-elevated px-4 py-2 text-sm text-muted">
            Sign in to see your current plan and upgrade.
          </p>
        )}

        {tab === "individual" ? (
          <div className="mt-10 grid w-full gap-5 md:grid-cols-3">
            <PlanCard
              name="Free"
              price="₹0"
              cadence="/month"
              current={!currentPlan || currentPlan.plan === "free"}
              cta="Current Plan"
              busy={false}
              disabled
              features={FREE_FEATURES}
              models={modelsByTier.free}
            />
            <PlanCard
              name="Pro"
              highlighted
              price={formatRupees(pro ? (annual ? pro.annualAmountPaise : pro.monthlyAmountPaise) : 0)}
              cadence={annual ? "/year" : "/month"}
              current={Boolean(currentPlan?.plan === "pro" && !currentPlan.isEnterprise)}
              cta="Upgrade to Pro"
              onBuy={() => void buyIndividual("pro")}
              busy={busyPlan === "pro"}
              disabled={busyPlan !== null || !config?.keyId || !signedIn}
              features={PRO_FEATURES}
              models={modelsByTier.pro}
            />
            <PlanCard
              name="Premium"
              price={formatRupees(premium ? (annual ? premium.annualAmountPaise : premium.monthlyAmountPaise) : 0)}
              cadence={annual ? "/year" : "/month"}
              current={Boolean(currentPlan?.plan === "premium" && !currentPlan.isEnterprise)}
              cta="Upgrade to Premium"
              onBuy={() => void buyIndividual("premium")}
              busy={busyPlan === "premium"}
              disabled={busyPlan !== null || !config?.keyId || !signedIn}
              features={PREMIUM_FEATURES}
              models={modelsByTier.premium}
            />
          </div>
        ) : (
          <div className="mt-10 flex w-full flex-col items-center">
            <div className="w-full max-w-md rounded-3xl border border-border bg-elevated p-6">
              <p className="text-xl font-semibold text-foreground">Enterprise</p>
              <p className="mt-3 font-mono text-3xl font-semibold text-foreground">
                {formatRupees(enterprisePerSeat)}
                <span className="ml-1 text-sm font-normal text-muted">/seat/{annual ? "year" : "month"}</span>
              </p>

              <div className="mt-5 flex flex-col gap-3">
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
                        onClick={() => void createOrgInline()}
                        className="h-10 rounded-full border border-border px-3 text-xs font-medium hover:bg-chip"
                      >
                        Create
                      </button>
                    </span>
                  )}
                </label>
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
                  disabled={busyPlan !== null || !config?.keyId || orgs.length === 0 || !signedIn}
                  onClick={() => void buyEnterprise()}
                  className="h-11 rounded-full bg-primary text-sm font-semibold text-primary-foreground disabled:opacity-50"
                >
                  {busyPlan === "enterprise" ? "Starting…" : `Pay ${formatRupees(enterprisePerSeat * seats)}`}
                </button>
              </div>

              <FeatureList items={ENTERPRISE_FEATURES} />
            </div>
          </div>
        )}

        {config && !config.keyId && (
          <p className="mt-6 text-xs text-muted">Razorpay keys are not configured on this environment yet.</p>
        )}
      </div>
    </div>
  );
}
