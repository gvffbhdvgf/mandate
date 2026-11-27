"use client";

import { useActionState } from "react";
import { signUpAction, type AuthActionState } from "../actions/auth";

const initialState: AuthActionState = {};

export function SignupForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(signUpAction, initialState);
  return (
    <>
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      <form action={action} className="form-stack" aria-busy={pending}>
        <input type="hidden" name="next" value={next} />
        <label htmlFor="signup-name">Your name<input id="signup-name" name="displayName" type="text" autoComplete="name" minLength={2} maxLength={160} required /></label>
        <label htmlFor="signup-email">Email address<input id="signup-email" name="email" type="email" autoComplete="email" inputMode="email" required /></label>
        <label htmlFor="signup-password">Password<input id="signup-password" name="password" type="password" autoComplete="new-password" minLength={10} aria-describedby="signup-password-help" required /><small id="signup-password-help">Use at least 10 characters. A longer passphrase is easier to remember and harder to guess.</small></label>
        <button className="primary-button" disabled={pending}>{pending ? "Creating your account…" : "Create account"}</button>
      </form>
    </>
  );
}
