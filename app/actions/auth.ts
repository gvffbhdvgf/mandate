"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../lib/supabase/server";
import { safeInternalPath } from "../../lib/navigation";

export type AuthActionState = { error?: string; message?: string; needsConfirmation?: boolean };

type AuthProviderError = {
  code?: string;
  status?: number;
  message: string;
};

function signUpErrorMessage(error: AuthProviderError): string {
  const code = error.code ?? "unknown";
  const message = error.message.toLowerCase();

  // Keep provider details and personal data out of the browser response.
  // The safe code/status pair is available in Cloudflare Worker logs for diagnosis.
  console.error("[auth.signup] Supabase rejected sign-up", {
    code,
    status: error.status ?? null,
  });

  if (code === "email_exists" || code === "user_already_exists") {
    return "An account with this email may already exist. Try signing in or resetting your password.";
  }
  if (code === "weak_password") {
    return "Choose a stronger password and try again.";
  }
  if (code === "email_address_invalid") {
    return "Enter a valid email address and try again.";
  }
  if (code === "over_email_send_rate_limit" || code === "over_request_rate_limit") {
    return "Too many confirmation attempts. Wait a little before trying again.";
  }
  if (code === "signup_disabled" || code === "email_provider_disabled") {
    return "New account registration is currently disabled. Contact your system administrator.";
  }
  if (code === "redirect_to_not_allowed" || message.includes("redirect")) {
    return "Account confirmation is not configured for this application address. Contact your system administrator.";
  }

  return "We could not create your account. Please try again. If the problem continues, contact your system administrator.";
}

export async function signInAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = safeInternalPath(String(formData.get("next") ?? ""));
  if (!email || !password) return { error: "Enter your email and password." };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error?.code === "email_not_confirmed") {
    return { error: "Your account is awaiting email confirmation. Open the confirmation email before signing in.", needsConfirmation: true };
  }
  if (error) return { error: "We could not sign you in. Check your details and try again." };

  redirect(next);
}

export async function signUpAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const displayName = String(formData.get("displayName") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = safeInternalPath(String(formData.get("next") ?? ""));
  if (displayName.length < 2 || displayName.length > 160) return { error: "Enter your name (2–160 characters)." };
  if (!email || password.length < 10) return { error: "Enter a valid email and a password of at least 10 characters." };

  const requestHeaders = await headers();
  const origin = requestHeaders.get("origin")
    ?? (requestHeaders.get("host") ? `https://${requestHeaders.get("host")}` : "http://localhost:3001");

  const callbackUrl = new URL("/auth/callback", origin);
  callbackUrl.searchParams.set("next", next);

  let sessionCreated = false;
  let authError: AuthProviderError | null = null;
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: callbackUrl.toString(),
        data: { display_name: displayName },
      },
    });
    sessionCreated = Boolean(data.session);
    authError = error;
  } catch (cause) {
    console.error("[auth.signup] Unexpected sign-up exception", {
      name: cause instanceof Error ? cause.name : "unknown",
    });
    return { error: "Account creation is temporarily unavailable. Please try again later." };
  }

  if (authError) return { error: signUpErrorMessage(authError) };
  if (sessionCreated) redirect(next);
  redirect(`/login?notice=confirm&next=${encodeURIComponent(next)}`);
}

export async function resendConfirmationAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const next = safeInternalPath(String(formData.get("next") ?? ""));
  if (!email || email.length > 254 || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
    return { error: "Enter a valid email address before requesting another confirmation email." };
  }

  const requestHeaders = await headers();
  const origin = requestHeaders.get("origin")
    ?? (requestHeaders.get("host") ? `https://${requestHeaders.get("host")}` : "http://localhost:3001");
  const callbackUrl = new URL("/auth/callback", origin);
  callbackUrl.searchParams.set("next", next);

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: callbackUrl.toString() },
    });
    if (error) {
      console.error("[auth.confirmation.resend] Supabase rejected resend", {
        code: error.code ?? "unknown",
        status: error.status ?? null,
      });
    }
  } catch (cause) {
    console.error("[auth.confirmation.resend] Unexpected resend exception", {
      name: cause instanceof Error ? cause.name : "unknown",
    });
  }

  return {
    message: "If this address is eligible for confirmation, a new email will be sent. Check your inbox and spam folder.",
  };
}

export async function requestPasswordResetAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "Enter a valid email address." };
  }

  const requestHeaders = await headers();
  const origin = requestHeaders.get("origin")
    ?? (requestHeaders.get("host") ? `https://${requestHeaders.get("host")}` : "http://localhost:3001");
  const callbackUrl = new URL("/auth/callback", origin);
  callbackUrl.searchParams.set("next", "/reset-password");

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: callbackUrl.toString(),
    });
    if (error) {
      console.error("[auth.password-reset] Supabase rejected reset request", {
        code: error.code ?? "unknown",
        status: error.status ?? null,
      });
    }
  } catch (cause) {
    console.error("[auth.password-reset] Unexpected reset exception", {
      name: cause instanceof Error ? cause.name : "unknown",
    });
  }

  // The same response is returned whether or not an account exists.
  return { message: "If an account exists for that address, a password reset email will be sent. Check your inbox and spam folder." };
}

export async function updatePasswordAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const password = String(formData.get("password") ?? "");
  const confirmation = String(formData.get("confirmPassword") ?? "");
  if (password.length < 10) return { error: "Choose a password of at least 10 characters." };
  if (password !== confirmation) return { error: "The passwords do not match." };

  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return { error: "Your reset session is missing or expired. Request a new password reset link." };
  }

  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    console.error("[auth.password-reset] Password update failed", {
      code: error.code ?? "unknown",
      status: error.status ?? null,
    });
    return { error: "We could not update your password. Request a new reset link and try again." };
  }

  redirect("/dashboard");
}

export async function signOutAction() {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
