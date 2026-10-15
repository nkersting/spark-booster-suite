import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

type State = "loading" | "ready" | "already" | "invalid" | "success" | "error";

export default function Unsubscribe() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const [state, setState] = useState<State>("loading");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) { setState("invalid"); return; }
    (async () => {
      try {
        const res = await fetch(
          `${SUPABASE_URL}/functions/v1/handle-email-unsubscribe?token=${encodeURIComponent(token)}`,
          { headers: { apikey: SUPABASE_KEY } },
        );
        const data = await res.json();
        if (!res.ok) { setState("invalid"); return; }
        if (data.valid === false && data.reason === "already_unsubscribed") setState("already");
        else if (data.valid) setState("ready");
        else setState("invalid");
      } catch {
        setState("error");
      }
    })();
  }, [token]);

  const confirm = async () => {
    if (!token) return;
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke("handle-email-unsubscribe", { body: { token } });
      if (error) { setState("error"); return; }
      if ((data as any)?.success) setState("success");
      else if ((data as any)?.reason === "already_unsubscribed") setState("already");
      else setState("error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-background">
      <div className="w-full max-w-md rounded-lg border bg-card p-8 text-card-foreground shadow-sm">
        <h1 className="text-xl font-semibold mb-3">Unsubscribe</h1>
        {state === "loading" && <p className="text-muted-foreground">Verifying your link…</p>}
        {state === "ready" && (
          <>
            <p className="text-muted-foreground mb-6">
              Click below to confirm you want to unsubscribe from DynamicTree emails.
            </p>
            <Button onClick={confirm} disabled={submitting}>
              {submitting ? "Working…" : "Confirm Unsubscribe"}
            </Button>
          </>
        )}
        {state === "success" && <p className="text-muted-foreground">You've been unsubscribed. We won't email you again.</p>}
        {state === "already" && <p className="text-muted-foreground">This address is already unsubscribed.</p>}
        {state === "invalid" && <p className="text-muted-foreground">This link is invalid or has expired.</p>}
        {state === "error" && <p className="text-muted-foreground">Something went wrong. Please try again later.</p>}
      </div>
    </div>
  );
}