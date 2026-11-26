import { createClient } from "npm:@supabase/supabase-js@2";

const json = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});
const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
function tokenString(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const fromEmail = Deno.env.get("RESEND_FROM_EMAIL");
  const siteUrl = Deno.env.get("MANDATE_SITE_URL");
  if (!supabaseUrl || !anonKey) return json(503, { error: "SUPABASE_FUNCTION_CONFIG_MISSING" });
  if (!resendApiKey || !fromEmail || !siteUrl) {
    return json(503, { error: "INVITATION_DELIVERY_NOT_CONFIGURED", message: "Configure the verified Resend sender and Mandate site URL before issuing organization invitations." });
  }

  let invitationUrl: URL;
  try {
    invitationUrl = new URL("/invitations/accept", siteUrl);
    if (invitationUrl.protocol !== "https:") return json(503, { error: "MANDATE_SITE_URL_MUST_USE_HTTPS" });
  } catch { return json(503, { error: "MANDATE_SITE_URL_INVALID" }); }

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json(401, { error: "AUTHENTICATION_REQUIRED" });
  const caller = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  });
  const { data: userData, error: userError } = await caller.auth.getUser();
  if (userError || !userData.user) return json(401, { error: "INVALID_SESSION" });

  let body: { organizationId?: string; email?: string; role?: string };
  try { body = await request.json(); } catch { return json(400, { error: "INVALID_REQUEST_BODY" }); }
  if (!body.organizationId || !/^[0-9a-f-]{36}$/i.test(body.organizationId)) return json(400, { error: "INVALID_ORGANIZATION_ID" });
  const email = String(body.email ?? "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: "INVALID_INVITATION_EMAIL" });
  const roles = ["admin", "election_manager", "returning_officer", "finance_manager", "viewer"];
  if (!body.role || !roles.includes(body.role)) return json(400, { error: "INVALID_INVITATION_ROLE" });

  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = tokenString(tokenBytes);
  const tokenHash = await sha256Hex(token);
  const { data: invitationId, error: createError } = await caller.rpc("create_organization_invitation", {
    p_organization_id: body.organizationId,
    p_email: email,
    p_role: body.role,
    p_token_hash: tokenHash,
  });
  if (createError || !invitationId) {
    const code = createError?.message ?? "INVITATION_CREATE_FAILED";
    if (code.includes("FORBIDDEN") || code.includes("ROLE_ASSIGNMENT_REQUIRES_OWNER")) return json(403, { error: code });
    if (code.includes("MEMBER_ALREADY_ACTIVE")) return json(409, { error: "MEMBER_ALREADY_ACTIVE" });
    return json(400, { error: code.includes("INVALID_INVITATION") ? code : "INVITATION_CREATE_FAILED" });
  }

  const { data: organization } = await caller.from("organizations").select("name").eq("id", body.organizationId).maybeSingle();
  const orgName = organization?.name ?? "your organization";
  // Keep the bearer token in the URL fragment: browsers do not send fragments
  // in HTTP requests, so it is not exposed to server/proxy logs or referrers.
  invitationUrl.hash = new URLSearchParams({ token }).toString();
  const safeOrgName = escapeHtml(orgName);
  const safeRole = escapeHtml(body.role.replaceAll("_", " "));
  let delivery: Response;
  try {
    delivery = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `mandate-org-invite-${invitationId}-${tokenHash}`,
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [email],
        subject: `Invitation to join ${orgName} on Mandate`,
        text: `You have been invited to join ${orgName} on Mandate as ${body.role.replaceAll("_", " ")}. Sign in or create an account using this email address, then accept your invitation: ${invitationUrl.toString()}. This invitation expires in seven days. If you were not expecting it, ignore this email.`,
        html: `<p>You have been invited to join <strong>${safeOrgName}</strong> on Mandate as <strong>${safeRole}</strong>.</p><p>Sign in or create an account using this email address, then <a href="${invitationUrl.toString()}">accept your invitation</a>.</p><p>This invitation expires in seven days. If you were not expecting it, you can ignore this email.</p>`,
      }),
    });
  } catch {
    // The provider outcome is unknown; retain the pending invite so a delivered
    // message cannot contain a token that we have already invalidated.
    return json(502, { error: "INVITATION_DELIVERY_UNCERTAIN" });
  }
  if (!delivery.ok) {
    await caller.rpc("revoke_organization_invitation", { p_invitation_id: invitationId });
    return json(502, { error: "INVITATION_DELIVERY_FAILED" });
  }
  return json(200, { invitationId, email, role: body.role, expiresInDays: 7, sent: true });
});
