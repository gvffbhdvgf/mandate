"use client";

import { useActionState } from "react";
import Link from "next/link";
import { resendSignupConfirmationAction, signInAction, type AuthActionState } from "../actions/auth";

const initialState: AuthActionState = {};

export function LoginForm({ next, notice }: { next: string; notice?: string }) {
  const [state, action, pending] = useActionState(signInAction, initialState);
  const [resendState, resendAction, resendPending] = useActionState(resendSignupConfirmationAction, initialState);

  return (
    <>
      {notice === "confirm" && (
        <p className="form-hint" role="status">
          Check your email to confirm your account, then sign in {next === "/invitations/accept" ? "to accept the invitation." : "to continue."}
        </p>
      )}
      {notice === "confirmation_failed" && <p className="form-error" role="alert">We could not complete email confirmation. Request a fresh confirmation email and try again.</p>}
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      <form action={action} className="form-stack">
        <input type="hidden" name="next" value={next} />
        <label>Email address<input name="email" type="email" autoComplete="email" required /></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
        <p className="auth-foot"><Link href={"/forgot-password?next=" + encodeURIComponent(next)}>Forgot your password?</Link></p>
        <button className="primary-button" disabled={pending}>{pending ? "Signing in…" : "Sign in"}</button>
      </form>
      <details className="auth-foot">
        <summary>Didn't receive the confirmation email?</summary>
        {resendState.error && <p className="form-error" role="alert">{resendState.error}</p>}
        {resendState.message && <p className="form-hint" role="status">{resendState.message}</p>}
        <form action={resendAction} className="form-stack">
          <input type="hidden" name="next" value={next} />
          <label>Email address<input name="email" type="email" autoComplete="email" required /></label>
          <button className="primary-button" disabled={resendPending}>{resendPending ? "Sending…" : "Resend confirmation email"}</button>
        </form>
      </details>
    </>
  );
}
