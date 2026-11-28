export function safeInternalPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\r\n]/.test(value)) {
    return "/dashboard";
  }
  try {
    const resolved = new URL(value, "https://mandate.invalid");
    if (resolved.origin !== "https://mandate.invalid" || resolved.hash !== "") return "/dashboard";

    if (resolved.pathname === "/invitations/accept") {
      return resolved.search === "" ? resolved.pathname : "/dashboard";
    }

    if (resolved.pathname === "/reset-password") {
      return resolved.search === "" ? resolved.pathname : "/dashboard";
    }

    if (resolved.pathname === "/payments/paystack/callback") {
      const entries = Array.from(resolved.searchParams.entries());
      const reference = resolved.searchParams.get("reference");
      if (entries.length !== 1 || !reference || !/^[A-Za-z0-9.=-]{8,100}$/.test(reference)) {
        return "/dashboard";
      }
      return `${resolved.pathname}?reference=${encodeURIComponent(reference)}`;
    }

    return "/dashboard";
  } catch {
    return "/dashboard";
  }
}
