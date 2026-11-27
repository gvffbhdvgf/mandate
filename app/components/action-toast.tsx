"use client";

import { useEffect, useState } from "react";

export function ActionToast({ message, tone = "success" }: { message?: string | null; tone?: "success" | "warning" }) {
  const [visible, setVisible] = useState(Boolean(message));

  useEffect(() => {
    if (!message) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const timeout = window.setTimeout(() => setVisible(false), 6000);
    return () => window.clearTimeout(timeout);
  }, [message]);

  if (!message || !visible) return null;

  return (
    <div className={`action-toast action-toast--${tone}`} role="status" aria-live="polite" aria-atomic="true">
      <span className="action-toast-icon" aria-hidden="true">{tone === "warning" ? "!" : "✓"}</span>
      <p>{message}</p>
      <button type="button" onClick={() => setVisible(false)} aria-label="Dismiss notification">×</button>
    </div>
  );
}
