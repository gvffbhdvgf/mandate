"use server";

import { env } from "cloudflare:workers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServerClient } from "../../lib/supabase/server";
import { safeInternalPath } from "../../lib/navigation";

export type AuthActionState = {
  error?: string;
  message?: string;
  status?: "confirmation_required" | "sent";
  email?: string;
  next?: string;
};

type AuthProviderError = { code?: string; status?: number; message: string };

const emailSchema = z.string().trim().email().max(254);
const nameSchema = z.string().trim().min(2).max(160);
const passwordSchema = z.string().min(10).max(128);

function providerFailure(scope: string, error: AuthProviderError) {
  console.warn(scope, { code: error.code ?? "unknown", status: error.status ?? null });
}

function signupError(error: AuthProviderError): string {
  const code = error.code ?? "unknown";
  providerFailure("[auth.signup] Supabase rejected sign-up", error);
  if (code === "weak_password") return "Choose a stronger password and try again.";
  if (code === "email_address_invalid") return "Enter a valid email address.";
  if (code === "over_email_send_rate_limit" || code === "over_request_rate_limit") return "Too many attempts. Wait a few minutes before trying again.";
  if (code === "signup_disabled" || code === "email_provider_disabled") return "New account registration is temporarily unavailable. Contact your administrator.";
  if (code === "redirect_to_not_allowed") return "Mandate's confirmation address is not configured correctly. Contact your administrator.";
  return "We couldn't complete registration. If you already have an account, sign in or reset your password.";
}

function canonicalSiteOrigin(): string {
  const configured = env.MANDATE_SITE_URL;
  if (!configured) throw new Error("MANDATE_SITE_URL is not configured");
  const url = new URL(configured);
  if (url.username || url.password || (url.protocol !== "https:" && url.hostname !== "localhost")) {
    throw new Error("MANDATE_SITE_URL must be a trusted HTTPS origin");
  }
  return url.origin;
}

function callbackUrl(next: string, flow: "signup" | "recovery" = "signup"): string {
  const url = new URL("/auth/callback", canonicalSiteOrigin());
  url.searchParams.set("next", safeInternalPath(next));
  url.searchParams.set("flow", flow);
  return url.toString();
}

function safeError(scope: string, cause: unknown) {
  console.error(scope, { name: cause instanceof Error ? cause.name : "unknown" });
}

export async function signInAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const email = emailSchema.safeParse(String(formData.get("email") ?? "").trim().toLowerCase());
  const password = String(formData.get("password") ?? "");
  const next = safeInternalPath(String(formData.get("next") ?? ""));
  if (!email.success || !password) return { error: "Enter a valid email address and your password." };

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.signInWithPassword({ email: email.data, password });
    if (error) {
      const providerError = error as AuthProviderError;
      providerFailure("[auth.signin] Supabase rejected sign-in", providerError);
      if (providerError.code === "email_not_confirmed" || providerError.message.toLowerCase().includes("email not confirmed")) {
        return { error: "Your email address still needs confirmation. Check your inbox or request a new confirmation email below." };
      }
      if (providerError.code === "invalid_credentials") {
        return { error: "The email or password is incorrect. Try again or reset your password." };
      }
      return { error: "Sign-in is temporarily unavailable. Please try again shortly." };
    }
  } catch (cause) {
    safeError("[auth.signin] Unexpected sign-in failure", cause);
    return { error: "Sign-in is temporarily unavailable. Please try again shortly." };
  }
  redirect(next);
}

export async function signUpAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const displayName = nameSchema.safeParse(String(formData.get("displayName") ?? ""));
  const email = emailSchema.safeParse(String(formData.get("email") ?? "").trim().toLowerCase());
  const password = passwordSchema.safeParse(String(formData.get("password") ?? ""));
  const next = safeInternalPath(String(formData.get("next") ?? ""));

  if (!displayName.success) return { error: "Enter your name (2–160 characters)." };
  if (!email.success) return { error: "Enter a valid email address." };
  if (!password.success) return { error: "Use a password between 10 and 128 characters." };

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.signUp({
      email: email.data,
      password: password.data,
      options: {
        emailRedirectTo: callbackUrl(next, "signup"),
        data: { display_name: displayName.data },
      },
    });
    if (error) return { error: signupError(error as AuthProviderError) };
    if (data.session) redirect(next);

    return {
      status: "confirmation_required",
      email: email.data,
      next,
      message: "If this address can be registered, Mandate has requested an email confirmation. Open the message to verify your address before signing in.",
    };
  } catch (cause) {
    // Next.js redirect is a control-flow exception; let it reach the framework.
    if (cause && typeof cause === "object" && "digest" in cause && String((cause as { digest?: unknown }).digest).startsWith("NEXT_REDIRECT")) throw cause;
    safeError("[auth.signup] Unexpected sign-up failure", cause);
    return { error: "Registration is temporarily unavailable. Please try again shortly." };
  }
}

export async function resendSignupConfirmationAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const email = emailSchema.safeParse(String(formData.get("email") ?? "").trim().toLowerCase());
  const next = safeInternalPath(String(formData.get("next") ?? ""));
  if (!email.success) return { error: "Enter a valid email address." };

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.resend({
      type: "signup",
      email: email.data,
      options: { emailRedirectTo: callbackUrl(next, "signup") },
    });
    if (error) providerFailure("[auth.confirmation-resend] Supabase rejected resend", error as AuthProviderError);
  } catch (cause) {
    safeError("[auth.confirmation-resend] Unexpected resend failure", cause);
  }
  return {
    status: "sent",
    email: email.data,
    next,
    message: "If an unconfirmed account exists for that address, a new confirmation message has been requested. Check your inbox and spam folder.",
  };
}

export async function requestPasswordResetAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const email = emailSchema.safeParse(String(formData.get("email") ?? "").trim().toLowerCase());
  const next = safeInternalPath(String(formData.get("next") ?? ""));
  if (!email.success) return { error: "Enter a valid email address." };

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email.data, {
      redirectTo: callbackUrl(next, "recovery"),
    });
    if (error) providerFailure("[auth.password-reset] Supabase rejected reset request", error as AuthProviderError);
  } catch (cause) {
    safeError("[auth.password-reset] Unexpected reset request failure", cause);
  }
  return { status: "sent", message: "If an account exists for that address, a secure password-reset email has been requested. Check your inbox and spam folder." };
}

export async function updatePasswordAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const password = passwordSchema.safeParse(String(formData.get("password") ?? ""));
  const confirmation = String(formData.get("confirmPassword") ?? "");
  const next = safeInternalPath(String(formData.get("next") ?? ""));
  if (!password.success) return { error: "Use a password between 10 and 128 characters." };
  if (password.data !== confirmation) return { error: "The passwords do not match." };

  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) return { error: "This password-reset link has expired. Request a new one." };
    const { error } = await supabase.auth.updateUser({ password: password.data });
    if (error) {
      providerFailure("[auth.password-reset] Password update rejected", error as AuthProviderError);
      return { error: "We couldn't update your password. Request a new reset link and try again." };
    }
  } catch (cause) {
    safeError("[auth.password-reset] Unexpected password update failure", cause);
    return { error: "Password update is temporarily unavailable. Request a new reset link and try again." };
  }
  redirect(next);
}

export async function signOutAction() {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signOut();
  if (error) providerFailure("[auth.signout] Supabase rejected sign-out", error as AuthProviderError);
  redirect("/login");
}
