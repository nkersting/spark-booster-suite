import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";

interface TryFreeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success" }
  | { kind: "exists" }
  | { kind: "error"; message: string };

export function TryFreeModal({ open, onOpenChange }: TryFreeModalProps) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const reset = () => {
    setEmail("");
    setStatus({ kind: "idle" });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setStatus({ kind: "loading" });
    try {
      const { data, error } = await supabase.functions.invoke("request-free-license", {
        body: { email: email.trim() },
      });
      if (error) throw error;
      if (data?.exists) {
        setStatus({ kind: "exists" });
        return;
      }
      if (data?.ok) {
        setStatus({ kind: "success" });
        return;
      }
      setStatus({ kind: "error", message: data?.error ?? "Something went wrong." });
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Something went wrong.",
      });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Try DynamicTree Free</DialogTitle>
          <DialogDescription>3 sessions, no credit card required</DialogDescription>
        </DialogHeader>

        {status.kind === "success" && (
          <div className="text-sm text-foreground">
            Check your email — your free access key is on its way.
          </div>
        )}

        {status.kind === "exists" && (
          <div className="text-sm text-foreground">
            You already have a free license. Check your email for your access key.
          </div>
        )}

        {(status.kind === "idle" || status.kind === "loading" || status.kind === "error") && (
          <form onSubmit={handleSubmit} className="space-y-3">
            <Input
              type="email"
              required
              autoFocus
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={status.kind === "loading"}
            />
            {status.kind === "error" && (
              <p className="text-sm text-destructive">{status.message}</p>
            )}
            <Button type="submit" className="w-full" disabled={status.kind === "loading"}>
              {status.kind === "loading" ? "Generating…" : "Get Free Access"}
            </Button>
            <p className="text-xs text-muted-foreground text-center">
              3 sessions, no credit card required
            </p>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
