import { createSupabaseServerClient } from "../../../lib/supabase/server";
import { safeInternalPath } from "../../../lib/navigation";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const next = safeInternalPath(requestUrl.searchParams.get("next"));
  const returnTo = safeInternalPath(requestUrl.searchParams.get("returnTo"));

  if (code) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return Response.redirect(new URL("/forgot-password?notice=expired", request.url), 302);
    }
  }

  if (next === "/update-password") {
    const destination = returnTo === "/update-password" ? "/dashboard" : returnTo;
    return Response.redirect(
      new URL(`/update-password?next=${encodeURIComponent(destination)}`, request.url),
      302,
    );
  }

  return Response.redirect(new URL(next, request.url), 302);
}
