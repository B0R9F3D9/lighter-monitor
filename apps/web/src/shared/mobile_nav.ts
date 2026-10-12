/**
 * Shared Mobile Navigation & Sandwich Menu Controller
 * Provides hamburger menu toggling, drawer expansion, backdrop interactions,
 * keyboard accessibility (Esc key), and responsive breakpoint synchronization.
 */

export interface MobileNavOptions {
  buttonId?: string;
  panelId?: string;
  onOpen?: () => void;
  onClose?: () => void;
}

export function initMobileNav(options?: MobileNavOptions): () => void {
  if (typeof document === "undefined") {
    return () => {};
  }

  const buttonId = options?.buttonId || "mobileMenuBtn";
  const panelId = options?.panelId || "mobileNavMenu";

  const toggleBtn = document.getElementById(buttonId);
  const menuPanel = document.getElementById(panelId);

  if (!toggleBtn || !menuPanel) {
    return () => {};
  }

  const openIcon = toggleBtn.querySelector(".hamburger-icon-open");
  const closeIcon = toggleBtn.querySelector(".hamburger-icon-close");

  const setOpen = (open: boolean) => {
    if (open) {
      menuPanel.classList.remove("hidden");
      toggleBtn.setAttribute("aria-expanded", "true");
      if (openIcon) {
        openIcon.classList.add("hidden");
        openIcon.classList.remove("block");
      }
      if (closeIcon) {
        closeIcon.classList.remove("hidden");
        closeIcon.classList.add("block");
      }
      options?.onOpen?.();
    } else {
      menuPanel.classList.add("hidden");
      toggleBtn.setAttribute("aria-expanded", "false");
      if (openIcon) {
        openIcon.classList.remove("hidden");
        openIcon.classList.add("block");
      }
      if (closeIcon) {
        closeIcon.classList.add("hidden");
        closeIcon.classList.remove("block");
      }
      options?.onClose?.();
    }
  };

  const handleToggle = (e: MouseEvent) => {
    e.stopPropagation();
    const isCurrentlyOpen = toggleBtn.getAttribute("aria-expanded") === "true";
    setOpen(!isCurrentlyOpen);
  };

  const handleDocClick = (e: MouseEvent) => {
    const target = e.target as Node | null;
    if (
      toggleBtn.getAttribute("aria-expanded") === "true" &&
      target &&
      !menuPanel.contains(target) &&
      !toggleBtn.contains(target)
    ) {
      setOpen(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && toggleBtn.getAttribute("aria-expanded") === "true") {
      setOpen(false);
      toggleBtn.focus();
    }
  };

  const handleResize = () => {
    if (window.innerWidth >= 1024 && toggleBtn.getAttribute("aria-expanded") === "true") {
      setOpen(false);
    }
  };

  // Close menu when clicking navigation links inside the drawer
  const navLinks = menuPanel.querySelectorAll("a");
  const handleLinkClick = () => {
    setOpen(false);
  };
  navLinks.forEach((link) => {
    link.addEventListener("click", handleLinkClick);
  });

  toggleBtn.addEventListener("click", handleToggle);
  document.addEventListener("click", handleDocClick);
  document.addEventListener("keydown", handleKeyDown);
  window.addEventListener("resize", handleResize);

  return () => {
    toggleBtn.removeEventListener("click", handleToggle);
    document.removeEventListener("click", handleDocClick);
    document.removeEventListener("keydown", handleKeyDown);
    window.removeEventListener("resize", handleResize);
    navLinks.forEach((link) => {
      link.removeEventListener("click", handleLinkClick);
    });
  };
}
