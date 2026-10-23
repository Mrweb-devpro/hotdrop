export async function copyText(text: string): Promise<void> {
  // LAN HTTP pages usually cannot access the modern Clipboard API.
  const fallback = () => {
    const active = document.activeElement as HTMLElement | null;
    const input = document.createElement("textarea");
    input.value = text;
    input.readOnly = true;
    input.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px;";
    document.body.appendChild(input);
    input.focus();
    input.select();
    input.setSelectionRange(0, text.length);
    try {
      if (!document.execCommand("copy")) throw new Error("Select and copy the text manually; this browser blocked copying.");
    } finally {
      input.remove();
      active?.focus();
    }
  };
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* try legacy copy */ }
  }
  fallback();
}
