"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../lib/supabase/server";

export type AuthActionState = { error?: string };

export async function signInAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password." };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: "We could not sign you in. Check your details and try again." };

  redirect("/dashboard");
}

export async function signUpAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const displayName = String(formData.get("displayName") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (displayName.length < 2 || displayName.length > 160) return { error: "Enter your name (2–160 characters)." };
  if (!email || password.length < 10) return { error: "Enter a valid email and a password of at least 10 characters." };

  const requestHeaders = await headers();
  const origin = requestHeaders.get("origin")
    ?? (requestHeaders.get("host") ? `https://${requestHeaders.get("host")}` : "http://localhost:3001");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: new URL("/auth/callback", origin).toString(),
      data: { display_name: displayName },
    },
  });

  if (error) return { error: "We could not create your account. Check the details or try signing in." };
  if (data.session) redirect("/dashboard");
  redirect("/login?notice=confirm");
}

export async function signOutAction() {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
