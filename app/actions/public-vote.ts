"use server";

import { createSupabaseServerClient } from "../../lib/supabase/server";

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
    return { verified: true, election: data.election };
  } catch {
    return { error: "We could not complete verification. Please try again." };
  }
}
