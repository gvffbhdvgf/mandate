"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../lib/supabase/server";
import { safeInternalPath } from "../../lib/navigation";

export type AuthActionState = { error?: string; message?: string };

type AuthProviderError = { code?: string; status?: number; message: string };

function signUpErrorMessage(error: AuthProviderError): string {
  const code = error.code ?? "unknown";
  const message = error.message.toLowerCase();
  console.error("[auth.signup] Supabase rejected sign-up", { code, status: error.status ?? null });
  if (code === "email_exists" || code === "user_already_exists") return "An account with this email may already exist. Try signing in or resetting your password.";
  if (code === "weak_password") return "Choose a stronger password and try again.";
  if (code === "email_address_invalid") return "Enter a valid email address and try again.";
  if (code === "over_email_send_rate_limit" || code === "over_request_rate_limit") return "Too many confirmation attempts. Wait a little before trying again.";
  if (code === "signup_disabled" || code === "email_provider_disabled") return "New account registration is currently disabled. Contact your system administrator.";
  if (code === "redirect_to_not_allowed" || message.includes("redirect")) return "Account confirmation is not configured for this application address. Contact your system administrator.";
  return "We could not create your account. Please try again. If the problem continues, contact your system administrator.";
}

function callbackUrlFor(requestOrigin: string, next: string): URL {
  const callbackUrl = new URL("/auth/callback", requestOrigin);
  callbackUrl.searchParams.set("next", next);
  return callbackUrl;
}

async function requestOrigin(): Promise<string> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host");
  return requestHeaders.get("origin") ?? (host ? "https://" + host : "http://localhost:3001");
}

export async function signInAction(_previousState: AuthActionState, formData: FormData): Promise<AuthActionState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = safeInternalPath(String(formData.get("next") ?? ""));
  if (!email || !password) return { error: "Enter your email and password." };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    const providerError = error as AuthProviderError;
    const code = providerError.code ?? "unknown";
    console.warn("[auth.signin] Supabase rejected sign-in", { code, status: providerError.status ?? null });
    if (code === "email_not_confirmed" || providerError.message.toLowerCase().includes("email not confirmed")) {
      return { error: "Your email address is not confirmed yet. Check your inbox for Mandate's confirmation email, or use the resend option below." };
    }
    return { error: "We could not sign you in. Check your details and try again." };
  }
  redirect(next);
}

export async function signUpAction(_previousState: AuthActionState, formData: FormData): Promise<AuthActionState> {
  const displayName = String(formData.get("displayName") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = safeInternalPath(String(formData.get("next") ?? ""));
  if (displayName.length < 2 || displayName.length > 160) return { error: "Enter your name (2–160 characters)." };
  if (!email || password.length < 10) return { error: "Enter a valid email and a password of at least 10 characters." };

  let sessionCreated = false;
  let authError: AuthProviderError | null = null;
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: callbackUrlFor(await requestOrigin(), next).toString(),
        data: { display_name: displayName },
      },
    });
    sessionCreated = Boolean(data.session);
    authError = error;
  } catch (cause) {
    console.error("[auth.signup] Unexpected sign-up exception", { name: cause instanceof Error ? cause.name : "unknown" });
    return { error: "Account creation is temporarily unavailable. Please try again later." };
  }

  if (authError) return { error: signUpErrorMessage(authError) };
  if (sessionCreated) redirect(next);
  redirect("/login?notice=confirm&next=" + encodeURIComponent(next));
}

export async function resendSignupConfirmationAction(_previousState: AuthActionState, formData: FormData): Promise<AuthActionState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const next = safeInternalPath(String(formData.get("next") ?? ""));
  if (!email || !email.includes("@")) return { error: "Enter a valid email address." };

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: callbackUrlFor(await requestOrigin(), next).toString() },
    });
    if (error) {
      const providerError = error as AuthProviderError;
      console.warn("[auth.confirmation-resend] Supabase rejected resend", {
        code: providerError.code ?? "unknown",
        status: providerError.status ?? null,
      });
    }
  } catch (cause) {
    console.error("[auth.confirmation-resend] Unexpected resend exception", { name: cause instanceof Error ? cause.name : "unknown" });
  }

  return { message: "If this address has an unconfirmed Mandate account, a confirmation email has been sent. Check your inbox and spam folder." };
}

export async function requestPasswordResetAction(_previousState: AuthActionState, formData: FormData): Promise<AuthActionState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const requestedNext = safeInternalPath(String(formData.get("next") ?? ""));
  const returnTo = requestedNext === "/update-password" ? "/dashboard" : requestedNext;
  if (!email || !email.includes("@")) return { error: "Enter a valid email address." };

  const callbackUrl = callbackUrlFor(await requestOrigin(), "/update-password");
  callbackUrl.searchParams.set("returnTo", returnTo);
  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: callbackUrl.toString() });
    if (error) {
      const providerError = error as AuthProviderError;
      console.error("[auth.password-reset] Supabase rejected reset request", { code: providerError.code ?? "unknown", status: providerError.status ?? null });
    }
  } catch (cause) {
    console.error("[auth.password-reset] Unexpected reset exception", { name: cause instanceof Error ? cause.name : "unknown" });
  }
  return { message: "If an account exists for that address, a password reset link will be sent." };
}

export async function updatePasswordAction(_previousState: AuthActionState, formData: FormData): Promise<AuthActionState> {
  const password = String(formData.get("password") ?? "");
  const confirmation = String(formData.get("confirmPassword") ?? "");
  const requestedNext = safeInternalPath(String(formData.get("next") ?? ""));
  const next = requestedNext === "/update-password" ? "/dashboard" : requestedNext;
  if (password.length < 10) return { error: "Choose a password of at least 10 characters." };
  if (password !== confirmation) return { error: "The passwords do not match." };

  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return { error: "Your reset session is missing or expired. Request a new password reset link." };

  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    const providerError = error as AuthProviderError;
    console.error("[auth.password-reset] Password update failed", { code: providerError.code ?? "unknown", status: providerError.status ?? null });
    return { error: "We could not update your password. Request a new reset link and try again." };
  }
  redirect(next);
}

export async function signOutAction() {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
