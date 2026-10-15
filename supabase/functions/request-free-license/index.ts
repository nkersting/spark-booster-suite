import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_BASE_URL = Deno.env.get("APP_BASE_URL") ?? "https://presentation.ironactionai.com";

const admin = createClient(SUPABASE_URL, SERVICE_KEY);

function isValidEmail(e: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const email = String(body?.email ?? "").trim().toLowerCase();
    if (!isValidEmail(email)) {
      return new Response(JSON.stringify({ ok: false, error: "Invalid email" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data, error } = await admin.rpc("request_free_license", { _email: email });
    if (error) {
      return new Response(JSON.stringify({ ok: false, error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const result = data as { ok: boolean; reason?: string; code?: string };

    if (!result?.ok && result?.reason === "exists") {
      // Don't reveal code; the original email was sent at creation time.
      return new Response(JSON.stringify({ ok: false, exists: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!result?.ok) {
      return new Response(JSON.stringify({ ok: false, error: result?.reason ?? "unknown" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Try to send the access-key email. If email infra isn't ready yet, log
    // the error so the license still gets created — admin can resend manually.
    try {
      const sendRes = await fetch(`${SUPABASE_URL}/functions/v1/send-transactional-email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SERVICE_KEY}`,
          apikey: SERVICE_KEY,
        },
        body: JSON.stringify({
          templateName: "free-access-key",
          recipientEmail: email,
          idempotencyKey: `free-key-${result.code}`,
          templateData: { code: result.code, appBaseUrl: APP_BASE_URL },
        }),
      });
      if (!sendRes.ok) {
        const text = await sendRes.text();
        console.error("Email send failed (non-fatal):", sendRes.status, text);
      }
    } catch (e) {
      console.error("Email send threw (non-fatal):", e);
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
