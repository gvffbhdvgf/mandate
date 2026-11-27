import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("signup uses a trusted canonical origin and returns an explicit confirmation state", async () => {
  const auth = await read("../app/actions/auth.ts");
  const signup = await read("../app/signup/signup-form.tsx");
  const cloudflare = await read("../cloudflare.config.ts");
  assert.match(auth, /canonicalSiteOrigin/);
  assert.match(auth, /env\.MANDATE_SITE_URL/);
  assert.doesNotMatch(auth, /headers\(\)|requestHeaders\.get\("host"\)|requestHeaders\.get\("origin"\)/);
  assert.match(auth, /status: "confirmation_required"/);
  assert.match(signup, /confirmation_required/);
  assert.match(signup, /Resend confirmation email/);
  assert.match(cloudflare, /MANDATE_SITE_URL: bindings\.text/);
});

test("password sign-in handles unconfirmed, invalid-credential and provider failures", async () => {
  const auth = await read("../app/actions/auth.ts");
  const login = await read("../app/login/login-form.tsx");
  assert.match(auth, /email_not_confirmed/);
  assert.match(auth, /invalid_credentials/);
  assert.match(auth, /Sign-in is temporarily unavailable/);
  assert.match(login, /Forgot your password/);
  assert.match(login, /Need a new confirmation email/);
});

test("confirmation resend and password reset are non-enumerating", async () => {
  const auth = await read("../app/actions/auth.ts");
  assert.match(auth, /auth\.resend\(/);
  assert.match(auth, /If an unconfirmed account exists/);
  assert.match(auth, /resetPasswordForEmail/);
  assert.match(auth, /If an account exists for that address/);
});

test("auth callback exchanges PKCE code and handles signup and recovery separately", async () => {
  const callback = await read("../app/auth/callback/route.ts");
  assert.match(callback, /exchangeCodeForSession\(code\)/);
  assert.match(callback, /flow === "recovery"/);
  assert.match(callback, /confirmation_failed/);
  assert.match(callback, /PKCE code exchange failed/);
});

test("password changes require a valid recovery session and matching bounded passwords", async () => {
  const auth = await read("../app/actions/auth.ts");
  const page = await read("../app/update-password/page.tsx");
  const form = await read("../app/update-password/update-password-form.tsx");
  assert.match(auth, /auth\.getUser\(\)/);
  assert.match(auth, /auth\.updateUser\(\{ password: password\.data \}\)/);
  assert.match(auth, /password\.data !== confirmation/);
  assert.match(page, /forgot-password\?notice=expired/);
  assert.match(form, /confirmPassword/);
});

test("sign-out checks the Supabase result and redirects to login", async () => {
  const auth = await read("../app/actions/auth.ts");
  assert.match(auth, /auth\.signOut\(\)/);
  assert.match(auth, /\[auth\.signout\]/);
  assert.match(auth, /redirect\("\/login"\)/);
});
