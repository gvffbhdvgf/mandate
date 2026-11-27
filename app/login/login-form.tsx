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
      {notice === "confirm" && <p className="form-hint" role="status">Your account request is recorded. Confirm your email before signing in.</p>}
      {notice === "confirmation_failed" && <p className="form-error" role="alert">We couldn't verify that confirmation link. Request a fresh email and try again.</p>}
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      <form action={action} className="form-stack">
        <input type="hidden" name="next" value={next} />
        <label>Email address<input name="email" type="email" autoComplete="username" required /></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
        <p className="auth-foot"><Link href={"/forgot-password?next=" + encodeURIComponent(next)}>Forgot your password?</Link></p>
        <button className="primary-button" disabled={pending}>{pending ? "Signing in…" : "Sign in"}</button>
      </form>
      <details className="auth-foot">
        <summary>Need a new confirmation email?</summary>
        {resendState.error && <p className="form-error" role="alert">{resendState.error}</p>}
        {resendState.message && <p className="form-hint" role="status">{resendState.message}</p>}
        <form action={resendAction} className="form-stack">
          <input type="hidden" name="next" value={next} />
          <label>Email address<input name="email" type="email" autoComplete="email" required /></label>
          <button className="secondary-button" disabled={resendPending}>{resendPending ? "Requesting…" : "Resend confirmation"}</button>
        </form>
      </details>
    </>
  );
}
