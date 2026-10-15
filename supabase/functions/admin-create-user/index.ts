import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const admin = createClient(SUPABASE_URL, SERVICE_KEY);

type AppRole = "admin" | "beta-user" | "user" | "disabled";
const VALID_ROLES: AppRole[] = ["admin", "beta-user", "user", "disabled"];

function isValidEmail(e: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;
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

    // Verify caller is admin
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
    const email = String(body?.email ?? "").trim().toLowerCase();
    const password = String(body?.password ?? "");
    const displayName = String(body?.displayName ?? "").trim() || null;
    const role = String(body?.role ?? "user") as AppRole;

    if (!isValidEmail(email)) return json({ error: "Invalid email" }, 400);
    if (password.length < 8) return json({ error: "Password must be at least 8 characters" }, 400);
    if (!VALID_ROLES.includes(role)) return json({ error: "Invalid role" }, 400);

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: displayName ? { display_name: displayName } : {},
    });
    if (createErr || !created?.user) {
      return json({ error: createErr?.message ?? "Failed to create user" }, 400);
    }

    // handle_new_user trigger creates a 'user' role; upgrade if needed.
    if (role !== "user") {
      const { error: upErr } = await admin
        .from("user_roles")
        .update({ role })
        .eq("user_id", created.user.id);
      if (upErr) console.error("Role update failed:", upErr);
    }

    return json({ ok: true, user_id: created.user.id });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "error" }, 500);
  }
});