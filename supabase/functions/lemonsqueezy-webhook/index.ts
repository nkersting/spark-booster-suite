import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const SIGNING_SECRET = Deno.env.get("LEMONSQUEEZY_SIGNING_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(SUPABASE_URL, SERVICE_KEY);

function tierFromProductName(name: string): {
  tier: "solo" | "team" | "org" | "test" | null;
  max_users: number;
  max_sessions: number | null;
} {
  const n = (name ?? "").toLowerCase();
  if (n.includes("test") || n.includes("10x") || n.includes("try")) {
    return { tier: "test", max_users: 1, max_sessions: 10 };
  }
  if (n.includes("organization") || n.includes("org")) return { tier: "org", max_users: 999, max_sessions: null };
  if (n.includes("team")) return { tier: "team", max_users: 5, max_sessions: null };
  if (n.includes("solo")) return { tier: "solo", max_users: 1, max_sessions: null };
  return { tier: null, max_users: 1, max_sessions: null };
}

function tierFromKnownProductId(productId: string | number | null | undefined) {
  // Lemon Squeezy's license_key_created event does not include product_name.
  // Known Product IDs are only used as a fallback when a matching order_created
  // payload is not available yet.
  const id = String(productId ?? "");
  if (id === "1192268") return { tier: "test" as const, max_users: 1, max_sessions: 10 };
  return { tier: null, max_users: 1, max_sessions: null };
}

// deno-lint-ignore no-explicit-any
function extractOrderProductName(payload: any, orderId?: string, orderItemId?: string): string {
  const attrs = payload?.data?.attributes ?? {};
  const item = attrs?.first_order_item;
  if (!item) return "";
  const itemOrderId = item?.order_id ? String(item.order_id) : "";
  const itemId = item?.id ? String(item.id) : "";
  const matchesOrder = orderId && (String(payload?.data?.id ?? "") === orderId || itemOrderId === orderId);
  const matchesItem = orderItemId && itemId === orderItemId;
  if (matchesOrder || matchesItem) return item?.product_name ?? "";
  return "";
}

async function findProductNameForLicense(orderId: string, orderItemId: string): Promise<string> {
  if (!orderId && !orderItemId) return "";
  const { data } = await admin
    .from("webhook_logs")
    .select("payload")
    .eq("event_type", "order_created")
    .order("created_at", { ascending: false })
    .limit(50);

  for (const row of data ?? []) {
    const productName = extractOrderProductName(row.payload, orderId, orderItemId);
    if (productName) return productName;
  }
  return "";
}

async function verifySignature(raw: string, signature: string | null): Promise<boolean> {
  if (!signature || !SIGNING_SECRET) return false;
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
  // Constant-time-ish compare.
  if (hex.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < hex.length; i++) mismatch |= hex.charCodeAt(i) ^ signature.charCodeAt(i);
  return mismatch === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const raw = await req.text();
  const signature = req.headers.get("x-signature");
  const eventType = req.headers.get("x-event-name") ?? "unknown";
  let payload: unknown = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = { raw };
  }

  // Always log regardless of outcome.
  const log = async (extra: Record<string, unknown>) => {
    await admin.from("webhook_logs").insert({
      event_type: eventType,
      payload: { ...(payload as object ?? {}), _meta: extra },
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

    if (eventType !== "order_created" && eventType !== "license_key_created") {
      await log({ ok: true, reason: "ignored_event" });
      return new Response(JSON.stringify({ ok: true, ignored: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Walk Lemon Squeezy payload shape: data.attributes + included[].
    // Be permissive about exact key paths.
    // deno-lint-ignore no-explicit-any
    const p = payload as any;
    const attrs = p?.data?.attributes ?? {};
    const buyer_email: string =
      attrs?.user_email ?? attrs?.customer_email ?? attrs?.email ?? "";
    const orderId = String(attrs?.order_id ?? p?.data?.id ?? "");
    const orderItemId = String(attrs?.order_item_id ?? attrs?.first_order_item?.id ?? "");
    let productName: string =
      attrs?.first_order_item?.product_name ??
      attrs?.product_name ??
      attrs?.order_items?.[0]?.product_name ??
      "";

    if (!productName && eventType === "license_key_created") {
      productName = await findProductNameForLicense(orderId, orderItemId);
    }

    // License key may live under included[type=license-keys].attributes.key
    let licenseKey = "";
    const included = Array.isArray(p?.included) ? p.included : [];
    for (const inc of included) {
      if (inc?.type === "license-keys" && inc?.attributes?.key) {
        licenseKey = inc.attributes.key;
        break;
      }
    }
    if (!licenseKey) {
      licenseKey =
        attrs?.key ?? attrs?.license_key?.key ?? attrs?.license_key ?? attrs?.first_order_item?.license_key?.key ?? "";
    }

    if (!licenseKey) {
      await log({ ok: true, reason: "waiting_for_license_key_event" });
      return new Response(JSON.stringify({ ok: true, waitingFor: "license_key_created" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const byName = tierFromProductName(productName);
    const { tier, max_users, max_sessions } = byName.tier
      ? byName
      : tierFromKnownProductId(attrs?.product_id);
    if (!tier) {
      await log({ ok: false, reason: "unknown_product", productName, productId: attrs?.product_id });
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
        buyer_email,
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
