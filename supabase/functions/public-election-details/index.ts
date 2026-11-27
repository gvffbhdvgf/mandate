import { adminClient, corsHeaders, json } from "../_shared/paystack.ts";

Deno.serve(async (request: Request) => {
  const cors = corsHeaders(request);
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED" }, cors);

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
  const { data: election, error } = await admin
    .from("elections")
    .select("title,description,public_slug,voting_mode,status,starts_at,ends_at,timezone,currency,price_per_credit_minor,max_credits_per_participant,contact_verification_required")
    .eq("public_slug", slug)
    .eq("voting_mode", "public_paid")
    .maybeSingle();

  if (error || !election) return json(404, { error: "PUBLIC_ELECTION_NOT_FOUND" }, cors);

  return json(200, {
    election: {
      title: election.title,
      description: election.description,
      slug: election.public_slug,
      status: election.status,
      startsAt: election.starts_at,
      endsAt: election.ends_at,
      timezone: election.timezone,
      currency: election.currency,
      pricePerCreditMinor: election.price_per_credit_minor,
      maxCreditsPerParticipant: election.max_credits_per_participant,
      contactVerificationRequired: election.contact_verification_required,
    },
  }, cors);
});
