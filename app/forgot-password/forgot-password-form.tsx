"use client";

import { useActionState } from "react";
import { requestPasswordResetAction, type AuthActionState } from "../actions/auth";

const initialState: AuthActionState = {};

export function ForgotPasswordForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(requestPasswordResetAction, initialState);
  return (
    <>
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      {state.message && <p className="form-hint" role="status">{state.message}</p>}
      <form action={action} className="form-stack">
        <input type="hidden" name="next" value={next} />
        <label>Email address<input name="email" type="email" autoComplete="email" required /></label>
        <button className="primary-button" disabled={pending}>{pending ? "Requesting…" : "Send password reset email"}</button>
      </form>
    </>
  );
}
