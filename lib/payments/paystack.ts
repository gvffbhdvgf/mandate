export function validatePaystackAuthorizationUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;

  let authorizationUrl: URL;
  try {
    authorizationUrl = new URL(value);
  } catch {
    return null;
  }

  if (authorizationUrl.protocol !== "https:" || !authorizationUrl.hostname.endsWith(".paystack.com")) {
    return null;
  }

  return authorizationUrl.toString();
}
