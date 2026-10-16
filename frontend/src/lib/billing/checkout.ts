export type BillingConfig = {
  provider: "razorpay";
  keyId: string | null;
  currency: "INR";
  annualDiscountPercent: number;
  individual: {
    id: "pro" | "premium";
    name: string;
    monthlyAmountPaise: number;
    annualAmountPaise: number;
    description: string;
  }[];
  enterprise: {
    id: "enterprise";
    name: string;
    perSeatMonthlyAmountPaise: number;
    minSeats: number;
    description: string;
  };
  /** Newer servers: the full catalog and public packages (older servers omit them). */
  plans?: CatalogPlan[];
  packages?: PublicPackage[];
};

export type Entitlements = {
  buildMode: boolean;
  fridayX: boolean;
  voice: boolean;
  canvas: boolean;
  images: boolean;
  connectors: number;
  buildMaxRounds: number;
  deepResearchPerDay: number;
  documentsPerDay: number;
  customSkills: number;
  libraryStorageMb: number;
  teamUpModels: number;
  mcpServers: number;
  automations: number;
  prioritySupport: boolean;
};

/** A plan from the console-edited catalog (GET /billing/config → plans). */
export type CatalogPlan = {
  id: "free" | "pro" | "premium" | "enterprise";
  name: string;
  tagline: string;
  monthlyPricePaise: number;
  annualPricePaise: number;
  annualDiscountPercent: number;
  minSeats: number | null;
  features: string[];
  badge: string | null;
  highlight: boolean;
  /** monthly = tokens per subscription month (individual plans); tokensPerSeat = enterprise pool per seat. */
  limits: { monthly: number | null; tokensPerSeat: number | null };
  entitlements: Entitlements;
};

/** A public package an admin built in the console, bought as a one-off order. */
export type PublicPackage = {
  id: string;
  name: string;
  description: string;
  target: "individual" | "organization";
  plan: string;
  pricePaise: number;
  currency: string;
  durationDays: number | null;
  monthlyTokenCap: number | null;
  seats: number | null;
  features: string[];
  entitlements: Partial<Entitlements>;
  badge: string | null;
  highlight: boolean;
};

export type CheckoutResponse = {
  checkout: { key: string; orderId: string; amount: number; currency: string; name: string; description: string };
};

export function formatRupees(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
}

export function amountForCyclePreview(monthlyAmountPaise: number, annualDiscount: boolean): number {
  return annualDiscount ? Math.round(monthlyAmountPaise * 12 * 0.9) : monthlyAmountPaise;
}

export async function loadRazorpayCheckout(): Promise<boolean> {
  const existing = (window as typeof window & { Razorpay?: unknown }).Razorpay;
  if (existing) return true;
  return new Promise<boolean>((resolve) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
}

/** Opens Razorpay's own checkout overlay for an already-created order. Returns a user-facing
 *  failure message if the checkout script couldn't load, or null on success. */
export async function openCheckout(res: CheckoutResponse): Promise<string | null> {
  const loaded = await loadRazorpayCheckout();
  const Razorpay = (window as typeof window & {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }).Razorpay;
  if (!loaded || !Razorpay) {
    return `Order created: ${res.checkout.orderId}. Razorpay Checkout could not load in this browser.`;
  }
  new Razorpay({
    key: res.checkout.key,
    amount: res.checkout.amount,
    currency: res.checkout.currency,
    name: res.checkout.name,
    description: res.checkout.description,
    order_id: res.checkout.orderId,
    theme: { color: "#111111" },
  }).open();
  return null;
}
