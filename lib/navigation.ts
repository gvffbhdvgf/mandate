export function safeInternalPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\r\n]/.test(value)) {
    return "/dashboard";
  }
  try {
    const resolved = new URL(value, "https://mandate.invalid");
    if (resolved.origin !== "https://mandate.invalid") return "/dashboard";
    if (resolved.pathname !== "/invitations/accept") return "/dashboard";
    const token = resolved.searchParams.get("token") ?? "";
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return "/dashboard";
    return `${resolved.pathname}?token=${encodeURIComponent(token)}`;
  } catch {
    return "/dashboard";
  }
}
