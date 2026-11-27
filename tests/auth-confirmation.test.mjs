import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("unconfirmed sign-in explains the confirmation requirement without exposing provider details", async () => {
  const auth = await read("../app/actions/auth.ts");
  assert.ok(auth.includes("email_not_confirmed"));
  assert.ok(auth.includes("use the resend option below"));
  assert.ok(auth.includes("[auth.signin] Supabase rejected sign-in"));
  assert.ok(!auth.includes("return { error: error.message"));
});

test("confirmation resend uses Supabase signup resend and a same-origin callback", async () => {
  const auth = await read("../app/actions/auth.ts");
  const login = await read("../app/login/login-form.tsx");
  assert.ok(auth.includes("resendSignupConfirmationAction"));
  assert.ok(auth.includes("auth.resend("));
  assert.ok(auth.includes('type: "signup"'));
  assert.ok(auth.includes("emailRedirectTo: callbackUrlFor"));
  assert.ok(auth.includes("If this address has an unconfirmed Mandate account"));
  assert.ok(login.includes("Resend confirmation email"));
  assert.ok(login.includes("resendSignupConfirmationAction"));
  assert.ok(login.includes("Didn't receive the confirmation email"));
});

test("confirmation notice only promises invitation acceptance for invitation destinations", async () => {
  const login = await read("../app/login/login-form.tsx");
  assert.ok(login.includes('next === "/invitations/accept"'));
  assert.ok(login.includes("to continue."));
});

test("auth callback reports expired or failed confirmation instead of silently redirecting", async () => {
  const callback = await read("../app/auth/callback/route.ts");
  assert.ok(callback.includes("callbackFailureUrl"));
  assert.ok(callback.includes("providerError || !code"));
  assert.ok(callback.includes("exchangeCodeForSession(code)"));
  assert.ok(callback.includes("confirmation_failed"));
  assert.ok(callback.includes("forgot-password?notice=expired"));
  assert.ok(callback.includes("[auth.callback] Code exchange failed"));
});

test("password recovery callback keeps its dedicated password update route", async () => {
  const callback = await read("../app/auth/callback/route.ts");
  assert.ok(callback.includes('next === "/update-password"'));
  assert.ok(callback.includes("returnTo"));
});
