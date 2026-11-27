"use client";

import { useActionState } from "react";
import { signInAction, type AuthActionState } from "../actions/auth";

const initialState: AuthActionState = {};

export function LoginForm({ next, notice }: { next: string; notice?: string }) {
  const [state, action, pending] = useActionState(signInAction, initialState);
  return (
    <>
      {notice === "confirm" && <p className="form-hint" role="status">Check your email to confirm your account, then sign in to accept the invitation.</p>}
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      <form action={action} className="form-stack" aria-busy={pending}>
        <input type="hidden" name="next" value={next} />
        <label htmlFor="login-email">Email address<input id="login-email" name="email" type="email" autoComplete="email" inputMode="email" required /></label>
        <label htmlFor="login-password">Password<input id="login-password" name="password" type="password" autoComplete="current-password" required /></label>
        <button className="primary-button" disabled={pending}>{pending ? "Signing in securely…" : "Sign in"}</button>
      </form>
    </>
  );
}
