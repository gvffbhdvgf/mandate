import { createSupabaseServerClient } from "../../../lib/supabase/server";
import { safeInternalPath } from "../../../lib/navigation";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const next = safeInternalPath(requestUrl.searchParams.get("next"));

  if (!code) {
    const destination = next === "/reset-password"
      ? "/forgot-password?notice=expired"
      : "/login?notice=callback";
    return Response.redirect(new URL(destination, request.url), 302);
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    console.error("[auth.callback] Supabase code exchange failed", {
      code: error.code ?? "unknown",
      status: error.status ?? null,
    });
    const destination = next === "/reset-password"
      ? "/forgot-password?notice=expired"
      : "/login?notice=callback";
    return Response.redirect(new URL(destination, request.url), 302);
  }

  return Response.redirect(new URL(next, request.url), 302);
}
