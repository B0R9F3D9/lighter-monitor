import { describe, expect, it, beforeEach, afterAll } from "bun:test";
import { highlightHeatmapHour, renderHourlyHeatmap } from "../src/analytics/heatmap";
import type { HourlyBucketStats } from "../src/analytics/types";

function createMockElement(tag: string = "div"): any {
  const listeners: Record<string, Function[]> = {};
  const children: any[] = [];
  const classListSet = new Set<string>();
  let currentClassName = "";

  const el: any = {
    tagName: tag.toUpperCase(),
    id: "",
    get className() {
      return currentClassName;
    },
    set className(val: string) {
      currentClassName = val;
      classListSet.clear();
      val
        .split(/\s+/)
        .filter(Boolean)
        .forEach((c) => classListSet.add(c));
    },
    innerHTML: "",
    style: {},
    children,
    scrollWidth: 1200,
    clientWidth: 800,
    scrollLeft: 0,
    scrollTo: (opts: any) => {
      if (opts && typeof opts.left === "number") {
        el.scrollLeft = opts.left;
      }
    },
    getBoundingClientRect: () => ({
      top: 100,
      bottom: 146,
      left: 200,
      right: 250,
      width: 50,
      height: 46,
    }),
    appendChild: (child: any) => {
      children.push(child);
      return child;
    },
    contains: (child: any) => children.includes(child),
    addEventListener: (evt: string, cb: Function) => {
      if (!listeners[evt]) listeners[evt] = [];
      listeners[evt].push(cb);
    },
    removeEventListener: (evt: string, cb: Function) => {
      if (listeners[evt]) {
        listeners[evt] = listeners[evt].filter((fn) => fn !== cb);
      }
    },
    dispatchEvent: (evt: string) => {
      if (listeners[evt]) {
        listeners[evt].forEach((fn) => fn({ type: evt }));
      }
    },
    classList: {
      contains: (cls: string) => classListSet.has(cls),
      add: (cls: string) => classListSet.add(cls),
      remove: (cls: string) => classListSet.delete(cls),
    },
  };
  return el;
}

describe("Execution Clock 24h Heatmap Ribbon", () => {
  const origDoc = (globalThis as any).document;
  const origWin = (globalThis as any).window;

  afterAll(() => {
    (globalThis as any).document = origDoc;
    (globalThis as any).window = origWin;
  });

  beforeEach(() => {
    const mockBody = createMockElement("body");
    const mockDoc: any = {
      body: mockBody,
      createElement: (tag: string) => createMockElement(tag),
      getElementById: (id: string) => (id === mockBody.id ? mockBody : null),
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    (globalThis as any).document = mockDoc;
    (globalThis as any).window = {
      innerWidth: 1024,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });

  const dummyBuckets: HourlyBucketStats[] = Array.from({ length: 24 }, (_, i) => ({
    hour: i,
    label: String(i).padStart(2, "0"),
    avgBasisUsd: i % 2 === 0 ? 0.25 : -0.15,
    avgBasisBps: 2.5,
    minBasisUsd: -0.5,
    maxBasisUsd: 1.0,
    sampleCount: 15,
    scoreNormalized: i / 24,
  }));

  it("renders a 24-cube ribbon with heatmap-ribbon class", () => {
    const container = createMockElement("div");
    renderHourlyHeatmap(container, dummyBuckets, 14);

    expect(container.children.length).toBe(1);
    const ribbon = container.children[0];
    expect(ribbon.className).toBe("heatmap-ribbon");
    expect(ribbon.children.length).toBe(24);
  });

  it("marks the current hour cell with an active accent ring and indicator", () => {
    const container = createMockElement("div");
    const currentHour = 10;
    renderHourlyHeatmap(container, dummyBuckets, currentHour);

    const ribbon = container.children[0];
    const currentCell = ribbon.children[currentHour];
    expect(currentCell.className).toContain("ring-1 ring-terminal-accent");
    expect(currentCell.className).toContain("ring-inset");
    expect(currentCell.className).toContain("z-10");
    expect(currentCell.className).toContain("border-terminal-accent");
    expect(currentCell.className).toContain("h-11.5");
    expect(currentCell.innerHTML).toContain("bg-terminal-accent");
    expect(currentCell.innerHTML).toContain("top-1 right-1");
    expect(currentCell.innerHTML).not.toContain("-top-1");
    expect(currentCell.innerHTML).not.toContain("-right-1");

    const otherCell = ribbon.children[5];
    expect(otherCell.className).not.toContain("ring-1 ring-terminal-accent");
    expect(otherCell.className).toContain("z-0");
  });

  it("invokes onHourClick callback with the selected hour index", () => {
    const container = createMockElement("div");
    let clickedHour = -1;
    renderHourlyHeatmap(container, dummyBuckets, 12, (hour) => {
      clickedHour = hour;
    });

    const ribbon = container.children[0];
    const cell7 = ribbon.children[7];
    cell7.dispatchEvent("click");

    expect(clickedHour).toBe(7);
  });

  it("dynamically moves highlighted hour block on crosshair hover and returns to current", () => {
    const container = createMockElement("div");
    const initialHour = 14;
    renderHourlyHeatmap(container, dummyBuckets, initialHour);

    const ribbon = container.children[0];
    const cell14 = ribbon.children[14];
    expect(cell14.className).toContain("ring-1 ring-terminal-accent");

    // Move hover to hour 8
    highlightHeatmapHour(container, 8);
    const cell8 = ribbon.children[8];
    expect(cell8.className).toContain("ring-1 ring-terminal-accent");
    expect(cell8.className).toContain("z-10");
    expect(cell14.className).not.toContain("ring-1 ring-terminal-accent");
    expect(cell14.className).toContain("z-0");

    // Move hover to hour 22
    highlightHeatmapHour(container, 22);
    const cell22 = ribbon.children[22];
    expect(cell22.className).toContain("ring-1 ring-terminal-accent");
    expect(cell22.className).toContain("z-10");
    expect(cell8.className).not.toContain("ring-1 ring-terminal-accent");
    expect(cell8.className).toContain("z-0");

    // Cursor leaves chart: returns to hour 14
    highlightHeatmapHour(container, initialHour);
    expect(cell14.className).toContain("ring-1 ring-terminal-accent");
    expect(cell14.className).toContain("z-10");
    expect(cell22.className).not.toContain("ring-1 ring-terminal-accent");
    expect(cell22.className).toContain("z-0");
  });
});
