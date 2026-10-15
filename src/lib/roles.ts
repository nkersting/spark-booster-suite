import { supabase } from "@/integrations/supabase/client";

/**
 * Role checks should prefer the backend role function to avoid RLS edge-cases.
 */
export async function hasRole(userId: string, role: "admin" | "beta-user" | "user" | "disabled") {
  const { data, error } = await supabase.rpc("has_role", {
    _user_id: userId,
    _role: role,
  });

  if (error) {
    // Fail closed for elevated permissions, fail open for non-critical checks.
    // Here we treat it as "no" to avoid accidentally granting access.
    console.error("Error checking role via RPC:", error);
    return false;
  }

  return Boolean(data);
}

export async function isDisabledUser(userId: string) {
  return hasRole(userId, "disabled");
}
