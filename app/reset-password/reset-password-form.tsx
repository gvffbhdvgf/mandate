"use client";

import { useActionState } from "react";
import { updatePasswordAction, type AuthActionState } from "../actions/auth";

const initialState: AuthActionState = {};

export function ResetPasswordForm() {
  const [state, action, pending] = useActionState(updatePasswordAction, initialState);
  return (
    <>
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      <form action={action} className="form-stack">
        <label>New password<input name="password" type="password" autoComplete="new-password" minLength={10} required /></label>
        <label>Confirm new password<input name="confirmPassword" type="password" autoComplete="new-password" minLength={10} required /></label>
        <button className="primary-button" disabled={pending}>{pending ? "Updating password…" : "Update password"}</button>
      </form>
    </>
  );
}
