// Pricing + Lemon Squeezy checkout URLs.
// Edit these constants directly to fill in real URLs and support email.

export const SUPPORT_EMAIL = "contact@ironactionai.com";

export const CHECKOUT_URLS = {
  test: "https://ironactionai.lemonsqueezy.com/checkout/buy/1b224633-e468-4645-93b8-17a955997f86",
  solo: "https://ironactionai.lemonsqueezy.com/checkout/buy/958d27a6-9349-4306-aaa1-79436a7d7dbe",
  team: "https://ironactionai.lemonsqueezy.com/checkout/buy/479041a4-f3bd-44dc-937f-dc80f17e1dd5",
  org: "https://ironactionai.lemonsqueezy.com/checkout/buy/4734e949-1e01-4e0b-b0e0-692c919dde3a",
} as const;

export type PricingTier = {
  id: "free" | "test" | "solo" | "team" | "org";
  label: string;
  price: string;
  blurb: string;
  url?: string;
  popular?: boolean;
  freeTrigger?: boolean;
};

export const PRICING_TIERS: PricingTier[] = [
  { id: "free", label: "Try Free", price: "Free", blurb: "3 sessions", freeTrigger: true },
  { id: "test", label: "Test", price: "$1", blurb: "10 sessions", url: CHECKOUT_URLS.test },
  { id: "solo", label: "Solo", price: "$39", blurb: "1 user, unlimited", url: CHECKOUT_URLS.solo, popular: true },
  { id: "team", label: "Team", price: "$79", blurb: "5 users, unlimited", url: CHECKOUT_URLS.team },
  { id: "org", label: "Organization", price: "$199", blurb: "Up to 999 users", url: CHECKOUT_URLS.org },
];
