import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Mandate — Organizational elections, made clear",
  description: "A clear, accountable election service for organizations.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">Skip to main content</a>
        <div id="main-content" tabIndex={-1}>{children}</div>
      </body>
    </html>
  );
}
