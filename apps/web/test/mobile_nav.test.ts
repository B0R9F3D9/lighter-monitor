import { describe, expect, it, beforeEach, afterAll } from "bun:test";
import { initMobileNav } from "../src/shared/mobile_nav";

describe("Mobile Navigation & Sandwich Menu", () => {
  const origDoc = (globalThis as any).document;
  const origWin = (globalThis as any).window;

  afterAll(() => {
    (globalThis as any).document = origDoc;
    (globalThis as any).window = origWin;
  });

  let btnListeners: Record<string, Function[]> = {};
  let docListeners: Record<string, Function[]> = {};
  let winListeners: Record<string, Function[]> = {};
  let linkListeners: Record<string, Function[]> = {};

  let btnAriaExpanded = "false";
  let panelHidden = true;
  let openIconHidden = false;
  let closeIconHidden = true;

  const mockOpenIcon = {
    classList: {
      add: (cls: string) => {
        if (cls === "hidden") openIconHidden = true;
      },
      remove: (cls: string) => {
        if (cls === "hidden") openIconHidden = false;
      },
    },
  };

  const mockCloseIcon = {
    classList: {
      add: (cls: string) => {
        if (cls === "hidden") closeIconHidden = true;
      },
      remove: (cls: string) => {
        if (cls === "hidden") closeIconHidden = false;
      },
    },
  };

  const mockLink = {
    addEventListener: (evt: string, cb: Function) => {
      if (!linkListeners[evt]) linkListeners[evt] = [];
      linkListeners[evt].push(cb);
    },
    removeEventListener: (evt: string, cb: Function) => {
      if (linkListeners[evt]) {
        linkListeners[evt] = linkListeners[evt].filter((fn) => fn !== cb);
      }
    },
  };

  const mockBtn = {
    id: "mobileMenuBtn",
    getAttribute: (attr: string) => (attr === "aria-expanded" ? btnAriaExpanded : null),
    setAttribute: (attr: string, val: string) => {
      if (attr === "aria-expanded") btnAriaExpanded = val;
    },
    querySelector: (sel: string) => {
      if (sel === ".hamburger-icon-open") return mockOpenIcon;
      if (sel === ".hamburger-icon-close") return mockCloseIcon;
      return null;
    },
    contains: (node: any) => node === mockBtn,
    focus: () => {},
    addEventListener: (evt: string, cb: Function) => {
      if (!btnListeners[evt]) btnListeners[evt] = [];
      btnListeners[evt].push(cb);
    },
    removeEventListener: (evt: string, cb: Function) => {
      if (btnListeners[evt]) {
        btnListeners[evt] = btnListeners[evt].filter((fn) => fn !== cb);
      }
    },
  };

  const mockPanel = {
    id: "mobileNavMenu",
    classList: {
      add: (cls: string) => {
        if (cls === "hidden") panelHidden = true;
      },
      remove: (cls: string) => {
        if (cls === "hidden") panelHidden = false;
      },
    },
    querySelectorAll: (sel: string) => {
      if (sel === "a") return [mockLink];
      return [];
    },
    contains: (node: any) => node === mockPanel,
  };

  beforeEach(() => {
    btnListeners = {};
    docListeners = {};
    winListeners = {};
    linkListeners = {};
    btnAriaExpanded = "false";
    panelHidden = true;
    openIconHidden = false;
    closeIconHidden = true;

    (globalThis as any).document = {
      getElementById: (id: string) => {
        if (id === "mobileMenuBtn") return mockBtn;
        if (id === "mobileNavMenu") return mockPanel;
        return null;
      },
      addEventListener: (evt: string, cb: Function) => {
        if (!docListeners[evt]) docListeners[evt] = [];
        docListeners[evt].push(cb);
      },
      removeEventListener: (evt: string, cb: Function) => {
        if (docListeners[evt]) {
          docListeners[evt] = docListeners[evt].filter((fn) => fn !== cb);
        }
      },
    };

    (globalThis as any).window = {
      innerWidth: 400,
      addEventListener: (evt: string, cb: Function) => {
        if (!winListeners[evt]) winListeners[evt] = [];
        winListeners[evt].push(cb);
      },
      removeEventListener: (evt: string, cb: Function) => {
        if (winListeners[evt]) {
          winListeners[evt] = winListeners[evt].filter((fn) => fn !== cb);
        }
      },
    };
  });

  it("toggles mobile menu open and closed when clicking the sandwich button", () => {
    let opened = false;
    let closed = false;

    const cleanup = initMobileNav({
      onOpen: () => {
        opened = true;
      },
      onClose: () => {
        closed = true;
      },
    });

    expect(btnAriaExpanded).toBe("false");
    expect(panelHidden).toBe(true);

    // Click button to open
    const clickEvt = { stopPropagation: () => {} };
    for (const fn of btnListeners["click"] || []) {
      fn(clickEvt);
    }

    expect(btnAriaExpanded).toBe("true");
    expect(panelHidden).toBe(false);
    expect(openIconHidden).toBe(true);
    expect(closeIconHidden).toBe(false);
    expect(opened).toBe(true);

    // Click button again to close
    for (const fn of btnListeners["click"] || []) {
      fn(clickEvt);
    }

    expect(btnAriaExpanded).toBe("false");
    expect(panelHidden).toBe(true);
    expect(openIconHidden).toBe(false);
    expect(closeIconHidden).toBe(true);
    expect(closed).toBe(true);

    cleanup();
  });

  it("closes menu when Escape key is pressed", () => {
    const cleanup = initMobileNav();

    // Open first
    for (const fn of btnListeners["click"] || []) {
      fn({ stopPropagation: () => {} });
    }
    expect(btnAriaExpanded).toBe("true");

    // Press Escape
    for (const fn of docListeners["keydown"] || []) {
      fn({ key: "Escape" });
    }

    expect(btnAriaExpanded).toBe("false");
    expect(panelHidden).toBe(true);

    cleanup();
  });

  it("closes menu when clicking outside the panel and button", () => {
    const cleanup = initMobileNav();

    // Open first
    for (const fn of btnListeners["click"] || []) {
      fn({ stopPropagation: () => {} });
    }
    expect(btnAriaExpanded).toBe("true");

    // Click outside
    const outsideNode = {};
    for (const fn of docListeners["click"] || []) {
      fn({ target: outsideNode });
    }

    expect(btnAriaExpanded).toBe("false");
    expect(panelHidden).toBe(true);

    cleanup();
  });

  it("closes menu when clicking a navigation link inside the panel", () => {
    const cleanup = initMobileNav();

    // Open first
    for (const fn of btnListeners["click"] || []) {
      fn({ stopPropagation: () => {} });
    }
    expect(btnAriaExpanded).toBe("true");

    // Click a nav link
    for (const fn of linkListeners["click"] || []) {
      fn({});
    }

    expect(btnAriaExpanded).toBe("false");
    expect(panelHidden).toBe(true);

    cleanup();
  });

  it("closes menu when viewport is resized to desktop width (>= 1024px)", () => {
    const cleanup = initMobileNav();

    // Open first
    for (const fn of btnListeners["click"] || []) {
      fn({ stopPropagation: () => {} });
    }
    expect(btnAriaExpanded).toBe("true");

    // Resize to desktop
    (globalThis as any).window.innerWidth = 1024;
    for (const fn of winListeners["resize"] || []) {
      fn({});
    }

    expect(btnAriaExpanded).toBe("false");
    expect(panelHidden).toBe(true);

    cleanup();
  });
});
