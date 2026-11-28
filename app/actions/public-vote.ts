"use server";

import { createSupabaseServerClient } from "../../lib/supabase/server";
import { validatePaystackAuthorizationUrl } from "../../lib/payments/paystack";

export type PublicElectionDetails = {
  title: string;
  description: string | null;
  slug: string;
  status: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  currency: string;
  pricePerCreditMinor: number;
  maxCreditsPerParticipant: number;
  contactVerificationRequired: boolean;
};

export async function getPublicElectionDetails(slug: string): Promise<PublicElectionDetails | null> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) return null;
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.functions.invoke("public-election-details", {
      body: { slug },
    });
    if (error || !data?.election) return null;
    return data.election as PublicElectionDetails;
  } catch {
    return null;
  }
}

export async function requestPublicParticipantOtp(emailValue: string) {
  const email = emailValue.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "Enter a valid email address." };
  }

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    });
    if (error) {
      // Avoid revealing whether the address already has an account.
      return { error: "We could not send a code right now. Check the address and try again shortly." };
    }
    return { sent: true };
  } catch {
    return { error: "Email verification is temporarily unavailable. Please try again." };
  }
}

export async function verifyPublicParticipantOtp(emailValue: string, tokenValue: string, slug: string) {
  const email = emailValue.trim().toLowerCase();
  const token = tokenValue.trim();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    || !/^\d{6}$/.test(token)
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
    || slug.length > 80) {
    return { error: "Enter the email address and six-digit code exactly as sent." };
  }

  try {
    const supabase = await createSupabaseServerClient();
    const { error: otpError } = await supabase.auth.verifyOtp({
      email,
      token,
      type: "email",
    });
    if (otpError) return { error: "That code is invalid or expired. Request a new code and try again." };

    const { data, error } = await supabase.functions.invoke("public-participant-session", {
      body: { slug },
    });
    if (error || data?.verified !== true) {
      return { error: "Your email is verified, but this election is not currently accepting participant sessions." };
    }
    const { data: ballotContext } = await supabase.rpc("get_public_paid_ballot_context", {
      p_election_slug: slug,
    });
    return { verified: true, election: data.election, ballotContext: ballotContext ?? null };
  } catch {
    return { error: "We could not complete verification. Please try again." };
  }
}


export async function initializePublicVoteCreditCheckout(slug: string, quantity: number, idempotencyKey: string) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80
    || !Number.isSafeInteger(quantity) || quantity < 1
    || !/^[A-Za-z0-9._:-]{16,200}$/.test(idempotencyKey)) {
    return { error: "Review the quantity and try again." };
  }

  try {
    const supabase = await createSupabaseServerClient();
    const { data: intent, error: intentError } = await supabase.functions.invoke("public-vote-credit-intent", {
      body: { slug, quantity },
      headers: { "Idempotency-Key": idempotencyKey },
    });
    if (intentError || !intent?.paymentIntentId) {
      const code = intent?.error;
      if (code === "PARTICIPANT_CREDIT_CAP_EXCEEDED") return { error: "This purchase would exceed the election's participant credit limit." };
      if (code === "PAYMENT_PURPOSE_DISABLED" || code === "PUBLIC_PAID_ELECTION_NOT_READY") return { error: "Paid checkout is not enabled for this election yet." };
      return { error: "We could not prepare checkout. Please try again." };
    }

    const { data: checkout, error: checkoutError } = await supabase.functions.invoke("paystack-initialize", {
      body: { paymentIntentId: intent.paymentIntentId },
    });
    if (checkoutError || !checkout?.authorizationUrl) {
      return { error: "Checkout could not be opened. Do not start another payment; retry this checkout or contact support." };
    }
    const authorizationUrl = validatePaystackAuthorizationUrl(checkout.authorizationUrl);
    if (!authorizationUrl) return { error: "Paystack returned an untrusted checkout address. No redirect was made." };
    return { authorizationUrl };
  } catch {
    return { error: "Checkout is temporarily unavailable. Please try again." };
  }
}


export async function getPublicParticipantSession(slug: string) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) return null;
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.functions.invoke("public-participant-session", {
      body: { slug },
    });
    if (error || data?.verified !== true) return null;
    return data.election;
  } catch {
    return null;
  }
}

export async function getPublicPaidBallotContext(slug: string) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) return null;
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("get_public_paid_ballot_context", {
      p_election_slug: slug,
    });
    if (error || !data) return null;
    return data;
  } catch {
    return null;
  }
}

export async function castPublicPaidBallot(
  slug: string,
  contestId: string,
  optionId: string,
  credits: number,
  idempotencyKey: string,
) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80
    || !/^[0-9a-f-]{36}$/i.test(contestId)
    || !/^[0-9a-f-]{36}$/i.test(optionId)
    || !Number.isSafeInteger(credits) || credits < 1
    || !/^[A-Za-z0-9._:-]{16,200}$/.test(idempotencyKey)) {
    return { error: "Review your selection and try again." };
  }

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("cast_public_paid_ballot", {
      p_election_slug: slug,
      p_contest_id: contestId,
      p_option_id: optionId,
      p_credits: credits,
      p_confirmation: true,
      p_idempotency_key: idempotencyKey,
    });
    if (error || !data) {
      const message = error?.message ?? "";
      if (message.includes("INSUFFICIENT_VOTE_CREDITS")) return { error: "You do not have enough available voting credits for this selection." };
      if (message.includes("ELECTION_NOT_OPEN")) return { error: "This election is no longer accepting ballots." };
      return { error: "Your ballot could not be recorded. Please check your balance and try again." };
    }

    const { data: context } = await supabase.rpc("get_public_paid_ballot_context", {
      p_election_slug: slug,
    });
    return { receiptCode: data.receiptCode, duplicate: data.duplicate === true, context: context ?? null };
  } catch {
    return { error: "Your ballot could not be recorded. Please try again." };
  }
}
