import { adminClient, authenticate, corsHeaders, json } from "../_shared/paystack.ts";

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request: Request) => {
  const cors = corsHeaders(request);
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED" }, cors);

  try {
    const { user } = await authenticate(request);
    const verifiedAt = user.email_confirmed_at ?? user.confirmed_at;
    if (!user.email || !verifiedAt) {
      return json(403, { error: "VERIFIED_EMAIL_REQUIRED" }, cors);
    }

    let body: { slug?: string };
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "INVALID_REQUEST_BODY" }, cors);
    }

    const slug = body.slug?.trim().toLowerCase() ?? "";
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) {
      return json(400, { error: "INVALID_PUBLIC_ELECTION" }, cors);
    }

    const admin = adminClient();
    const { data: election, error: electionError } = await admin
      .from("elections")
      .select("id,title,status,voting_mode,starts_at,ends_at,timezone,currency,price_per_credit_minor,max_credits_per_participant,contact_verification_required,paid_voting_authorized_at")
      .eq("public_slug", slug)
      .maybeSingle();

    if (electionError || !election) return json(404, { error: "PUBLIC_ELECTION_NOT_FOUND" }, cors);
    if (election.voting_mode !== "public_paid"
      || election.status !== "open"
      || !election.contact_verification_required
      || !election.paid_voting_authorized_at
      || election.currency !== "KES"
      || !Number.isSafeInteger(Number(election.price_per_credit_minor))
      || Number(election.price_per_credit_minor) <= 0
      || !Number.isSafeInteger(Number(election.max_credits_per_participant))
      || Number(election.max_credits_per_participant) < 1) {
      return json(409, { error: "PUBLIC_PAID_ELECTION_NOT_READY" }, cors);
    }

    const now = Date.now();
    if (now < Date.parse(election.starts_at) || now >= Date.parse(election.ends_at)) {
      return json(409, { error: "ELECTION_NOT_OPEN" }, cors);
    }

    // Do not persist the email in participant, payment or ballot tables.
    // The verified Auth UUID is the stable pseudonymous participant identity.
    const contactHash = await sha256Hex(`mandate-public-participant:${user.id}`);
    const { data: existing, error: existingError } = await admin
      .from("public_participants")
      .select("id,verification_status")
      .eq("election_id", election.id)
      .eq("auth_user_id", user.id)
      .maybeSingle();

    if (existingError) return json(500, { error: "PARTICIPANT_STATE_UNAVAILABLE" }, cors);
    if (existing?.verification_status === "blocked") {
      return json(403, { error: "PARTICIPANT_BLOCKED" }, cors);
    }

    if (existing?.verification_status === "unverified") {
      const { error: verifyError } = await admin
        .from("public_participants")
        .update({ verification_status: "verified" })
        .eq("id", existing.id)
        .eq("verification_status", "unverified");
      if (verifyError) return json(500, { error: "PARTICIPANT_VERIFICATION_PERSIST_FAILED" }, cors);
    }

    if (!existing) {
      const { error: insertError } = await admin.from("public_participants").insert({
        election_id: election.id,
        auth_user_id: user.id,
        contact_hash: contactHash,
        verification_status: "verified",
      });
      if (insertError && insertError.code !== "23505") {
        return json(500, { error: "PARTICIPANT_REGISTRATION_FAILED" }, cors);
      }
      // A concurrent request may have won the unique insert; verify its state.
      const { data: concurrent, error: concurrentError } = await admin
        .from("public_participants")
        .select("verification_status")
        .eq("election_id", election.id)
        .eq("auth_user_id", user.id)
        .maybeSingle();
      if (concurrentError || !concurrent || concurrent.verification_status !== "verified") {
        return json(409, { error: "PARTICIPANT_REGISTRATION_CONFLICT" }, cors);
      }
    }

    return json(200, {
      verified: true,
      election: {
        title: election.title,
        slug,
        currency: election.currency,
        pricePerCreditMinor: Number(election.price_per_credit_minor),
        maxCreditsPerParticipant: election.max_credits_per_participant,
        endsAt: election.ends_at,
        timezone: election.timezone,
      },
    }, cors);
  } catch (error) {
    const code = error instanceof Error ? error.message : "PARTICIPANT_SESSION_FAILED";
    const status = code === "AUTHENTICATION_REQUIRED" || code === "INVALID_SESSION" ? 401
      : code === "FORBIDDEN" ? 403
      : code === "SUPABASE_FUNCTION_CONFIG_MISSING" ? 503
      : 500;
    return json(status, { error: code }, cors);
  }
});
