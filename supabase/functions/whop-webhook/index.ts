import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const SIGNING_SECRET = Deno.env.get("WHOP_SIGNING_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(SUPABASE_URL, SERVICE_KEY);

function tierFromProductName(name: string): {
  tier: "solo" | "team" | "org" | "test" | "free" | null;
  max_users: number;
  max_sessions: number | null;
} {
  const n = (name ?? "").toLowerCase();
  if (n.includes("organization")) return { tier: "org", max_users: 999, max_sessions: null };
  if (n.includes("team")) return { tier: "team", max_users: 5, max_sessions: null };
  if (n.includes("solo")) return { tier: "solo", max_users: 1, max_sessions: null };
  if (n.includes("test")) return { tier: "test", max_users: 1, max_sessions: 10 };
  if (n.includes("free")) return { tier: "free", max_users: 1, max_sessions: 3 };
  return { tier: null, max_users: 1, max_sessions: null };
}

async function verifySignature(raw: string, signature: string | null): Promise<boolean> {
  if (!signature || !SIGNING_SECRET) return false;
  // Whop may send signatures as "sha256=<hex>" or "t=..,v1=<hex>" style; support both plain hex and sha256= prefix.
  let provided = signature.trim();
  if (provided.startsWith("sha256=")) provided = provided.slice("sha256=".length);

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(raw));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (hex.length !== provided.length) return false;
  let mismatch = 0;
  for (let i = 0; i < hex.length; i++) mismatch |= hex.charCodeAt(i) ^ provided.charCodeAt(i);
  return mismatch === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const raw = await req.text();
  const signature =
    req.headers.get("x-whop-signature") ??
    req.headers.get("whop-signature") ??
    req.headers.get("x-signature");

  let payload: unknown = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = { raw };
  }

  // deno-lint-ignore no-explicit-any
  const p = payload as any;
  const eventType: string = p?.event ?? p?.type ?? req.headers.get("x-whop-event") ?? "unknown";

  const log = async (extra: Record<string, unknown>) => {
    await admin.from("webhook_logs").insert({
      event_type: eventType,
      payload: { ...(payload as object ?? {}), _meta: { source: "whop", ...extra } },
    });
  };

  try {
    const valid = await verifySignature(raw, signature);
    if (!valid) {
      await log({ ok: false, reason: "invalid_signature" });
      return new Response(JSON.stringify({ error: "invalid signature" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (eventType !== "purchase.completed") {
      await log({ ok: true, reason: "ignored_event" });
      return new Response(JSON.stringify({ ok: true, ignored: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = p?.data ?? p;
    const licenseKey: string =
      data?.license_key ??
      data?.license?.key ??
      data?.membership?.license_key ??
      "";
    const buyerEmail: string =
      data?.user_email ??
      data?.email ??
      data?.buyer_email ??
      data?.user?.email ??
      data?.customer?.email ??
      "";
    const productName: string =
      data?.product_name ??
      data?.product?.name ??
      data?.plan?.product_name ??
      data?.plan?.name ??
      "";

    if (!licenseKey) {
      await log({ ok: false, reason: "missing_license_key" });
      return new Response(JSON.stringify({ error: "missing license key" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { tier, max_users, max_sessions } = tierFromProductName(productName);
    if (!tier) {
      await log({ ok: false, reason: "unknown_product", productName });
      return new Response(JSON.stringify({ error: "unknown product" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { error: insertErr } = await admin.from("licenses").upsert(
      {
        code: licenseKey,
        tier,
        max_users,
        max_sessions,
        sessions_used: 0,
        active_users: 0,
        buyer_email: buyerEmail,
        active: true,
      },
      { onConflict: "code" },
    );

    if (insertErr) {
      await log({ ok: false, reason: "db_error", message: insertErr.message });
      return new Response(JSON.stringify({ error: insertErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await log({ ok: true, tier, licenseKey });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    await log({ ok: false, reason: "exception", message: err instanceof Error ? err.message : String(err) });
    return new Response(JSON.stringify({ error: "internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});