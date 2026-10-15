import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const admin = createClient(SUPABASE_URL, SERVICE_KEY);

type LicenseTier = "free" | "test" | "solo" | "team" | "org";
const VALID_TIERS: LicenseTier[] = ["free", "test", "solo", "team", "org"];

function tierDefaults(tier: LicenseTier): { max_users: number; max_sessions: number | null } {
  switch (tier) {
    case "free":
      return { max_users: 1, max_sessions: 3 };
    case "test":
      return { max_users: 1, max_sessions: 10 };
    case "team":
      return { max_users: 5, max_sessions: null };
    case "org":
      return { max_users: 999, max_sessions: null };
    case "solo":
    default:
      return { max_users: 1, max_sessions: null };
  }
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Missing auth" }, 401);

    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "Invalid session" }, 401);

    const { data: isAdmin, error: roleErr } = await admin.rpc("has_role", {
      _user_id: userData.user.id,
      _role: "admin",
    });
    if (roleErr || !isAdmin) return json({ error: "Admin required" }, 403);

    const body = await req.json().catch(() => ({}));
    const code = String(body?.code ?? "").trim();
    const tier = String(body?.tier ?? "solo") as LicenseTier;
    const buyerEmail = String(body?.buyer_email ?? "").trim().toLowerCase();

    if (!code) return json({ error: "Code required" }, 400);
    if (code.length > 255) return json({ error: "Code is too long" }, 400);
    if (!VALID_TIERS.includes(tier)) return json({ error: "Invalid tier" }, 400);
    if (buyerEmail && !isValidEmail(buyerEmail)) return json({ error: "Invalid buyer email" }, 400);

    const defaults = tierDefaults(tier);
    const maxUsers = body?.max_users === null || body?.max_users === undefined || body?.max_users === ""
      ? defaults.max_users
      : Number(body.max_users);
    const maxSessions = body?.max_sessions === null || body?.max_sessions === undefined || body?.max_sessions === ""
      ? defaults.max_sessions
      : Number(body.max_sessions);

    if (!Number.isInteger(maxUsers) || maxUsers < 1) return json({ error: "Max users must be at least 1" }, 400);
    if (maxSessions !== null && (!Number.isInteger(maxSessions) || maxSessions < 0)) {
      return json({ error: "Max sessions must be blank or 0+" }, 400);
    }

    const { data, error } = await admin
      .from("licenses")
      .insert({
        code,
        tier,
        max_users: maxUsers,
        max_sessions: maxSessions,
        sessions_used: 0,
        active_users: 0,
        buyer_email: buyerEmail || null,
        active: true,
      })
      .select("code, tier, max_users, max_sessions, sessions_used, active_users, buyer_email, active, created_at")
      .single();

    if (error) {
      const duplicate = error.code === "23505" || error.message.toLowerCase().includes("duplicate");
      return json({ error: duplicate ? "A license with this code already exists" : error.message }, duplicate ? 409 : 400);
    }

    return json({ ok: true, license: data });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Failed to create license" }, 500);
  }
});