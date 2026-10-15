import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { PricingSection } from "@/components/PricingSection";
import { TryFreeModal } from "@/components/TryFreeModal";

export default function Plans() {
  const [tryFreeOpen, setTryFreeOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background py-10 px-4">
      <div className="max-w-5xl mx-auto space-y-8">
        <div className="text-center space-y-2">
          <h1 className="text-2xl sm:text-3xl font-bold text-foreground">Subscription Plans</h1>
          <p className="text-sm text-muted-foreground">Choose the plan that fits you best.</p>
        </div>

        <PricingSection onTryFree={() => setTryFreeOpen(true)} />

        <div className="text-center">
          <Link to="/" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
        </div>
      </div>

      <TryFreeModal open={tryFreeOpen} onOpenChange={setTryFreeOpen} />
    </div>
  );
}
