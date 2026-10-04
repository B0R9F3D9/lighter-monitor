export function copyToClipboard(
  text: string,
  btnEl: HTMLButtonElement,
  originalLabel: string,
): void {
  if (btnEl.dataset.isCopied === "true") return;

  const originalClass = btnEl.dataset.originalClass || btnEl.className;
  btnEl.dataset.originalClass = originalClass;

  const doCopyFeedback = () => {
    btnEl.dataset.isCopied = "true";
    btnEl.textContent = "COPIED";
    btnEl.classList.remove("text-terminal-muted", "text-terminal-accent");
    btnEl.classList.add("text-terminal-emerald");

    setTimeout(() => {
      delete btnEl.dataset.isCopied;
      btnEl.textContent = btnEl.dataset.label || originalLabel;
      btnEl.className = originalClass;
      delete btnEl.dataset.originalClass;
    }, 1000);
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(text)
      .then(doCopyFeedback)
      .catch(() => {
        if (fallbackCopy(text)) {
          doCopyFeedback();
        }
      });
  } else {
    if (fallbackCopy(text)) {
      doCopyFeedback();
    }
  }
}

function fallbackCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let success = false;
  try {
    success = document.execCommand("copy");
  } catch {}
  document.body.removeChild(ta);
  return success;
}
