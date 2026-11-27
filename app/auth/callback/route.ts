import { createSupabaseServerClient } from "../../../lib/supabase/server";
import { safeInternalPath } from "../../../lib/navigation";

function callbackFailureUrl(requestUrl: URL, next: string): URL {
  if (next === "/update-password") return new URL("/forgot-password?notice=expired", requestUrl);
  return new URL("/login?notice=confirmation_failed&next=" + encodeURIComponent(next), requestUrl);
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const providerError = requestUrl.searchParams.get("error");
  const next = safeInternalPath(requestUrl.searchParams.get("next"));
  const returnTo = safeInternalPath(requestUrl.searchParams.get("returnTo"));

  if (providerError || !code) {
    console.warn("[auth.callback] Provider callback did not include a usable code", {
      error: providerError ?? "missing_code",
      errorCode: requestUrl.searchParams.get("error_code"),
    });
    return Response.redirect(callbackFailureUrl(requestUrl, next), 302);
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    console.warn("[auth.callback] Code exchange failed", { code: error.code ?? "unknown", status: error.status ?? null });
    return Response.redirect(callbackFailureUrl(requestUrl, next), 302);
  }

  if (next === "/update-password") {
    const destination = returnTo === "/update-password" ? "/dashboard" : returnTo;
    return Response.redirect(new URL("/update-password?next=" + encodeURIComponent(destination), request.url), 302);
  }
  return Response.redirect(new URL(next, request.url), 302);
}
