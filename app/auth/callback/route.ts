import { createSupabaseServerClient } from "../../../lib/supabase/server";
import { safeInternalPath } from "../../../lib/navigation";

function failureUrl(origin: string, flow: string, next: string): URL {
  if (flow === "recovery") return new URL("/forgot-password?notice=expired", origin);
  return new URL("/login?notice=confirmation_failed&next=" + encodeURIComponent(next), origin);
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const providerError = requestUrl.searchParams.get("error");
  const flow = requestUrl.searchParams.get("flow") ?? "";
  const next = safeInternalPath(requestUrl.searchParams.get("next"));

  if (providerError || !code) {
    console.warn("[auth.callback] Provider callback is incomplete", {
      error: providerError ?? "missing_code",
      errorCode: requestUrl.searchParams.get("error_code"),
      flow: flow === "recovery" ? "recovery" : "signup",
    });
    return Response.redirect(failureUrl(requestUrl.origin, flow, next), 302);
  }

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      console.warn("[auth.callback] PKCE code exchange failed", {
        code: error.code ?? "unknown",
        status: error.status ?? null,
        flow: flow === "recovery" ? "recovery" : "signup",
      });
      return Response.redirect(failureUrl(requestUrl.origin, flow, next), 302);
    }
  } catch (cause) {
    console.error("[auth.callback] Unexpected callback failure", {
      name: cause instanceof Error ? cause.name : "unknown",
    });
    return Response.redirect(failureUrl(requestUrl.origin, flow, next), 302);
  }

  if (flow === "recovery") {
    return Response.redirect(new URL("/update-password?next=" + encodeURIComponent(next), requestUrl.origin), 302);
  }
  return Response.redirect(new URL(next, requestUrl.origin), 302);
}
