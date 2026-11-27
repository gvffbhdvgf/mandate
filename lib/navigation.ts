export function safeInternalPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\r\n]/.test(value)) {
    return "/dashboard";
  }
  try {
    const resolved = new URL(value, "https://mandate.invalid");
    if (resolved.origin !== "https://mandate.invalid") return "/dashboard";
    if (resolved.pathname !== "/invitations/accept") return "/dashboard";
    if (resolved.pathname !== "/invitations/accept" || resolved.search !== "" || resolved.hash !== "") return "/dashboard";
    return resolved.pathname;
  } catch {
    return "/dashboard";
  }
}
