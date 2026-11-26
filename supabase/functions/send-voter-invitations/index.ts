import { createClient } from "npm:@supabase/supabase-js@2";

type Voter = {
  id: string;
  display_name: string;
  normalized_email: string | null;
};

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

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
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const fromEmail = Deno.env.get("RESEND_FROM_EMAIL");
  const siteUrl = Deno.env.get("MANDATE_SITE_URL");

  if (!supabaseUrl || !anonKey || !serviceRoleKey) return json(503, { error: "SUPABASE_FUNCTION_CONFIG_MISSING" });
  if (!resendApiKey || !fromEmail || !siteUrl) {
    return json(503, { error: "INVITATION_DELIVERY_NOT_CONFIGURED", message: "Configure a verified Resend sender and Mandate site URL before issuing voter access." });
  }

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json(401, { error: "AUTHENTICATION_REQUIRED" });

  const caller = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  });
  const { data: userData, error: userError } = await caller.auth.getUser();
  if (userError || !userData.user) return json(401, { error: "INVALID_SESSION" });

  let body: { electionId?: string };
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "INVALID_REQUEST_BODY" });
  }
  if (!body.electionId || !/^[0-9a-f-]{36}$/i.test(body.electionId)) return json(400, { error: "INVALID_ELECTION_ID" });

  const { data: election, error: electionError } = await caller
    .from("elections")
    .select("id,organization_id,title,status,voting_mode")
    .eq("id", body.electionId)
    .maybeSingle();
  if (electionError || !election) return json(404, { error: "ELECTION_NOT_FOUND" });
  if (election.status !== "draft" || election.voting_mode === "public_paid") {
    return json(409, { error: "ELECTION_NOT_ELIGIBLE_FOR_INVITATIONS" });
  }

  const { data: membership, error: membershipError } = await caller
    .from("organization_members")
    .select("role,status")
    .eq("organization_id", election.organization_id)
    .eq("user_id", userData.user.id)
    .maybeSingle();
  if (membershipError || !membership || membership.status !== "active"
    || !["owner", "admin", "election_manager"].includes(membership.role)) {
    return json(403, { error: "FORBIDDEN" });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { count: skippedNoEmail } = await admin
    .from("election_voters")
    .select("id", { count: "exact", head: true })
    .eq("election_id", election.id)
    .eq("eligibility_status", "eligible")
    .is("invited_at", null)
    .is("access_token_hash", null)
    .is("normalized_email", null);

  const { data: voters, error: voterError } = await admin
    .from("election_voters")
    .select("id,display_name,normalized_email")
    .eq("election_id", election.id)
    .eq("eligibility_status", "eligible")
    .is("invited_at", null)
    .is("access_token_hash", null)
    .not("normalized_email", "is", null)
    .order("created_at", { ascending: true })
    .limit(50);
  if (voterError) return json(500, { error: "VOTER_REGISTER_LOOKUP_FAILED" });
  if (!voters?.length) return json(200, { attempted: 0, sent: 0, skippedNoEmail: skippedNoEmail ?? 0, failed: 0, hasMore: false });

  let sent = 0;
  let failed = 0;
  const voteUrl = new URL("/vote/", siteUrl);

  for (const voter of voters as Voter[]) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = tokenString(bytes);
    const tokenHash = await sha256Hex(token);

    const { data: claim, error: tokenError } = await admin
      .from("election_voters")
      .update({ access_token_hash: tokenHash, invited_at: null })
      .eq("id", voter.id)
      .is("invited_at", null)
      .is("access_token_hash", null)
      .select("id")
      .maybeSingle();
    if (tokenError) {
      failed += 1;
      continue;
    }
    if (!claim) continue;

    const invitationUrl = `${voteUrl.toString()}#${token}`;
    const name = escapeHtml(voter.display_name || "Voter");
    const title = escapeHtml(election.title);

    let delivery: Response;
    try {
      delivery = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `mandate-voter-invite-${election.id}-${voter.id}-${tokenHash}`,
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [voter.normalized_email],
          subject: `Your invitation to vote: ${election.title}`,
          text: `Hello ${voter.display_name}, you are invited to vote in ${election.title}. Open this secure link: ${invitationUrl}. Keep this link private. If you did not expect this invitation, contact the election administrator.`,
          html: `<p>Hello ${name},</p><p>You are invited to vote in <strong>${title}</strong>.</p><p><a href="${invitationUrl}">Open your secure ballot</a></p><p>Keep this link private. If you did not expect this invitation, contact the election administrator.</p>`,
        }),
      });
    } catch {
      await admin.from("election_voters").update({ access_token_hash: null }).eq("id", voter.id).is("invited_at", null);
      failed += 1;
      continue;
    }

    if (!delivery.ok) {
      await admin.from("election_voters").update({ access_token_hash: null }).eq("id", voter.id).is("invited_at", null);
      failed += 1;
      continue;
    }

    const { error: markInvitedError } = await admin
      .from("election_voters")
      .update({ invited_at: new Date().toISOString() })
      .eq("id", voter.id)
      .eq("access_token_hash", tokenHash)
      .is("invited_at", null);
    if (markInvitedError) {
      await admin.from("election_voters").update({ access_token_hash: null })
        .eq("id", voter.id).eq("access_token_hash", tokenHash).is("invited_at", null);
      failed += 1;
      continue;
    }
    sent += 1;
  }

  await admin.from("audit_events").insert({
    organization_id: election.organization_id,
    election_id: election.id,
    actor_id: userData.user.id,
    actor_type: "user",
    action: "voter_invitation.batch_dispatched",
    entity_type: "election",
    entity_id: election.id,
    redacted_metadata: { attempted: voters.length, sent, skippedNoEmail, failed },
  });

  return json(200, {
    attempted: voters.length,
    sent,
    skippedNoEmail: skippedNoEmail ?? 0,
    failed,
    hasMore: voters.length === 50,
  });
});
