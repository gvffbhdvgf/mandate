"use client";

import { useActionState } from "react";
import { signUpAction, type AuthActionState } from "../actions/auth";

const initialState: AuthActionState = {};

export function SignupForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(signUpAction, initialState);
  return (
    <>
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      <form action={action} className="form-stack">
        <input type="hidden" name="next" value={next} />
        <label>Your name<input name="displayName" type="text" autoComplete="name" minLength={2} maxLength={160} required /></label>
        <label>Email address<input name="email" type="email" autoComplete="email" required /></label>
        <label>Password<input name="password" type="password" autoComplete="new-password" minLength={10} required /></label>
        <button className="primary-button" disabled={pending}>{pending ? "Creating account…" : "Create account"}</button>
      </form>
    </>
  );
}
