import { PRICING_TIERS } from "@/config/pricing";

interface PricingSectionProps {
  onTryFree: () => void;
}

export function PricingSection({ onTryFree }: PricingSectionProps) {
  return (
    <div className="w-full max-w-5xl mx-auto">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        {PRICING_TIERS.map((t) => {
          const isUrl = Boolean(t.url) && !t.url?.startsWith("TODO_");
          const Card: React.ElementType = t.freeTrigger ? "button" : isUrl ? "a" : "button";
          const props: Record<string, unknown> = t.freeTrigger
            ? { type: "button", onClick: onTryFree }
            : isUrl
            ? { href: t.url, target: "_blank", rel: "noopener noreferrer" }
            : { type: "button", disabled: true, title: "Checkout URL not configured yet" };

          return (
            <Card
              key={t.id}
              {...props}
              className={`relative flex flex-col items-start text-left rounded-lg border bg-card p-4 transition hover:border-primary hover:shadow-md focus:outline-none focus:ring-2 focus:ring-ring ${
                t.popular ? "border-primary ring-1 ring-primary/40" : "border-border"
              }`}
            >
              {t.popular && (
                <span className="absolute -top-2 right-3 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-foreground">
                  Most Popular
                </span>
              )}
              <div className="text-sm font-semibold text-foreground">{t.label}</div>
              <div className="mt-1 text-xl font-bold text-foreground">{t.price}</div>
              <div className="mt-1 text-xs text-muted-foreground">{t.blurb}</div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
