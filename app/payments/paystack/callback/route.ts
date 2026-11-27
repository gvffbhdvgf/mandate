import { createSupabaseServerClient } from "../../../../lib/supabase/server";

const referencePattern = /^[A-Za-z0-9.=-]{8,100}$/;

function statusPage(status: number, title: string, message: string, returnPath = "/dashboard") {
  const safeReturnPath = /^\/public-vote\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(returnPath)
    || /^\/organizations\/[0-9a-f-]{36}\/elections\/[0-9a-f-]{36}$/i.test(returnPath)
    ? returnPath
    : "/dashboard";
  const returnLabel = safeReturnPath === "/dashboard" ? "Return to Mandate" : "Continue to your election";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${title} · Mandate</title>
<style>
body{font-family:system-ui,sans-serif;background:#f6f7f9;color:#18202b;margin:0;min-height:100vh;display:grid;place-items:center}
main{background:white;border:1px solid #e5e7eb;border-radius:16px;padding:32px;max-width:480px;margin:20px;box-shadow:0 12px 32px #10182812}
h1{font-size:1.4rem;margin:0 0 12px}p{line-height:1.6;color:#4b5563}a{color:#155eef;font-weight:600}
</style>
</head>
<body><main><h1>${title}</h1><p>${message}</p><p><a href="${safeReturnPath}">${returnLabel}</a></p></main></body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const reference = requestUrl.searchParams.get("reference") ?? requestUrl.searchParams.get("trxref");
  if (!reference || !referencePattern.test(reference)) {
    return statusPage(400, "Invalid payment reference", "The payment reference is missing or invalid. Return to Mandate and reopen the payment.");
  }

  try {
    const supabase = await createSupabaseServerClient();
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError || !authData.user) {
      const next = `/payments/paystack/callback?reference=${encodeURIComponent(reference)}`;
      const loginUrl = new URL(`/login?next=${encodeURIComponent(next)}`, requestUrl.origin);
      return Response.redirect(loginUrl, 302);
    }

    const { data, error } = await supabase.functions.invoke("paystack-verify", {
      body: { reference },
    });
    if (error) {
      return statusPage(503, "Payment verification pending", "Mandate could not confirm the payment with Paystack just now. Do not pay again. Return to Mandate and check the payment status shortly.");
    }
    if (data?.status === "success" && data?.verified === true) {
      return statusPage(
        200,
        "Payment verified",
        data.returnPath ? "Paystack confirmed your payment and your voting credits are ready. Continue to your election to cast your ballot." : "Paystack confirmed this payment. Your organization payment record is updated. If a balance or service has not updated yet, it may still require settlement processing.",
        typeof data.returnPath === "string" ? data.returnPath : "/dashboard",
      );
    }
    if (data?.status === "pending") {
      return statusPage(
        202,
        "Payment is still processing",
        "Paystack has not reported a final successful payment yet. Do not pay again; check the payment status again shortly.",
        typeof data.returnPath === "string" ? data.returnPath : "/dashboard",
      );
    }
    return statusPage(409, "Payment needs review", "Mandate could not confirm a matching successful payment. No credit or balance is issued by this callback. Contact your organization finance administrator if the payment was debited.");
  } catch {
    return statusPage(503, "Payment verification unavailable", "Mandate could not verify the payment right now. Do not pay again. Return to Mandate and check the payment status shortly.");
  }
}
