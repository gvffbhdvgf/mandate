export function safeInternalPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\r\n]/.test(value)) {
    return "/dashboard";
  }
  try {
    const resolved = new URL(value, "https://mandate.invalid");
    const allowedPaths = new Set(["/dashboard", "/invitations/accept"]);
    if (resolved.origin !== "https://mandate.invalid" || !allowedPaths.has(resolved.pathname)) return "/dashboard";
    if (resolved.search !== "" || resolved.hash !== "") return "/dashboard";
    return resolved.pathname;
  } catch {
    return "/dashboard";
  }
}
