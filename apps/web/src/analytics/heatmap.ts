import type { HourlyBucketStats } from "./types";

let sharedHeatmapTooltip: HTMLElement | null = null;

function getOrCreateHeatmapTooltip(): HTMLElement {
  const isDetached =
    typeof document?.body?.contains === "function" && !document.body.contains(sharedHeatmapTooltip);
  if (!sharedHeatmapTooltip || isDetached) {
    const existing = document.getElementById("heatmapSharedTooltip");
    if (existing) {
      sharedHeatmapTooltip = existing;
    } else {
      const tip = document.createElement("div");
      tip.id = "heatmapSharedTooltip";
      tip.className =
        "fixed z-50 pointer-events-none whitespace-nowrap bg-terminal-bg border border-terminal-border px-2.5 py-1.5 rounded shadow-2xl text-[10px] font-mono text-terminal-secondary opacity-0 transition-opacity duration-75 select-none";
      tip.style.display = "none";
      document.body.appendChild(tip);
      sharedHeatmapTooltip = tip;

      // Automatically hide on scroll or window resize to prevent detached tooltips
      const hideTip = () => {
        if (sharedHeatmapTooltip) {
          sharedHeatmapTooltip.style.opacity = "0";
          sharedHeatmapTooltip.style.display = "none";
        }
      };
      window.addEventListener("scroll", hideTip, { passive: true });
      window.addEventListener("resize", hideTip, { passive: true });
    }
  }
  return sharedHeatmapTooltip;
}

interface HeatmapCellState {
  bucket: HourlyBucketStats;
  isCurrent: boolean;
  borderClass: string;
  onHourClick?: (hour: number) => void;
}

const cellStateMap = new WeakMap<HTMLElement, HeatmapCellState>();

export function renderHourlyHeatmap(
  container: HTMLElement,
  buckets: HourlyBucketStats[],
  currentHourLocal: number,
  onHourClick?: (hour: number) => void,
): void {
  const firstChild = container.children?.[0] as HTMLElement | undefined;
  const isExisting =
    firstChild &&
    firstChild.className === "heatmap-ribbon" &&
    firstChild.children?.length === buckets.length;

  const tooltip = getOrCreateHeatmapTooltip();
  let grid: HTMLElement;

  if (isExisting) {
    grid = firstChild;
  } else {
    container.innerHTML = "";
    grid = document.createElement("div");
    grid.className = "heatmap-ribbon";

    grid.addEventListener("mouseleave", () => {
      tooltip.style.opacity = "0";
      tooltip.style.display = "none";
    });

    container.addEventListener(
      "scroll",
      () => {
        tooltip.style.opacity = "0";
        tooltip.style.display = "none";
      },
      { passive: true },
    );
  }

  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i]!;
    const isCurrent = b.hour === currentHourLocal;
    let cell: HTMLElement;

    if (isExisting) {
      cell = grid.children[i] as HTMLElement;
    } else {
      cell = document.createElement("div");

      cell.addEventListener("mouseenter", () => {
        const state = cellStateMap.get(cell);
        if (!state) return;
        const { bucket, isCurrent: cur } = state;
        const sign = bucket.avgBasisUsd > 0 ? "+" : "";
        const nextHour = String((bucket.hour + 1) % 24).padStart(2, "0");
        tooltip.innerHTML = `
          <div class="font-bold text-white mb-0.5">${bucket.label}:00 - ${nextHour}:00 ${cur ? "(Current)" : ""}</div>
          <div class="flex justify-between gap-3"><span>Avg Basis:</span> <span class="text-white font-bold tabular-nums">${sign}$${bucket.avgBasisUsd.toFixed(3)} (${sign}${bucket.avgBasisBps.toFixed(1)} bps)</span></div>
          <div class="flex justify-between gap-3"><span>Range:</span> <span class="tabular-nums">$${bucket.minBasisUsd.toFixed(2)} .. $${bucket.maxBasisUsd.toFixed(2)}</span></div>
          <div class="flex justify-between gap-3 text-terminal-muted"><span>Samples:</span> <span class="tabular-nums">${bucket.sampleCount}</span></div>
        `;
        tooltip.style.display = "block";
        tooltip.style.opacity = "1";

        const cellRect = cell.getBoundingClientRect();
        const tipRect = tooltip.getBoundingClientRect();
        const padding = 10;
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth;

        let left = cellRect.left + (cellRect.width - tipRect.width) / 2;
        left = Math.max(padding, Math.min(viewportWidth - tipRect.width - padding, left));

        let top = cellRect.top - tipRect.height - 6;
        if (top < padding) {
          top = cellRect.bottom + 6;
        }

        tooltip.style.left = `${Math.round(left)}px`;
        tooltip.style.top = `${Math.round(top)}px`;
      });

      cell.addEventListener("mouseleave", () => {
        tooltip.style.opacity = "0";
        tooltip.style.display = "none";
      });

      cell.addEventListener("click", () => {
        const state = cellStateMap.get(cell);
        if (state?.onHourClick) {
          state.onHourClick(state.bucket.hour);
        }
      });

      grid.appendChild(cell);
    }

    // Sleek dark container with clearly visible colored frame borders
    const bgClass = "bg-terminal-surface";
    let borderClass = "border-terminal-border";
    let textClass = "text-terminal-secondary";

    if (b.sampleCount > 0) {
      if (b.scoreNormalized <= 0.25) {
        borderClass = "border-terminal-emerald/60 hover:border-terminal-emerald";
        textClass = "text-terminal-emerald font-semibold";
      } else if (b.scoreNormalized <= 0.55) {
        borderClass = "border-terminal-border hover:border-terminal-muted";
        textClass = "text-terminal-primary";
      } else if (b.scoreNormalized <= 0.75) {
        borderClass = "border-terminal-amber/50 hover:border-terminal-amber";
        textClass = "text-terminal-amber";
      } else {
        borderClass = "border-terminal-coral/60 hover:border-terminal-coral";
        textClass = "text-terminal-coral font-semibold";
      }
    } else {
      borderClass = "border-terminal-border/40";
      textClass = "text-terminal-muted";
    }

    cellStateMap.set(cell, { bucket: b, isCurrent, borderClass, onHourClick });

    const activeSelectedClass = isCurrent
      ? "z-10 border-terminal-accent ring-1 ring-terminal-accent ring-inset"
      : `z-0 ${borderClass}`;

    cell.className = `relative flex flex-col items-center justify-center h-11.5 px-0.5 rounded border cursor-pointer transition select-none hover:bg-terminal-surfaceHover ${bgClass} ${activeSelectedClass}`;
    if (cell.dataset) {
      cell.dataset.hour = String(b.hour);
    }

    const sign = b.avgBasisUsd > 0 ? "+" : "";
    const basisLabel = b.sampleCount > 0 ? `${sign}$${b.avgBasisUsd.toFixed(2)}` : "—";

    cell.innerHTML = `
      <div class="text-[10px] font-bold ${textClass} tabular-nums">${b.label}</div>
      <div class="text-[9px] font-mono ${textClass} tabular-nums mt-0.5 truncate w-full text-center">${basisLabel}</div>
      ${isCurrent ? '<span class="heatmap-current-dot absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-terminal-accent pointer-events-none"></span>' : ""}
    `;
  }

  if (!isExisting) {
    container.appendChild(grid);
  }

  if (
    typeof requestAnimationFrame === "function" &&
    currentHourLocal >= 0 &&
    currentHourLocal < 24
  ) {
    requestAnimationFrame(() => {
      const currentCell = grid.children[currentHourLocal] as HTMLElement | undefined;
      if (currentCell && container.scrollWidth > container.clientWidth) {
        const offset =
          currentCell.offsetLeft - (container.clientWidth - currentCell.clientWidth) / 2;
        if (typeof container.scrollTo === "function") {
          container.scrollTo({ left: Math.max(0, offset), behavior: "smooth" });
        } else {
          container.scrollLeft = Math.max(0, offset);
        }
      }
    });
  }
}

/**
 * Dynamically moves the active accent ring & indicator dot to targetHour
 * without full ribbon re-rendering for optimal 60fps chart hover responsiveness.
 */
export function highlightHeatmapHour(container: HTMLElement, targetHour: number): void {
  const grid = (container.firstElementChild || container.children?.[0]) as HTMLElement | null;
  if (!grid || !grid.children || grid.children.length === 0) return;

  for (let i = 0; i < grid.children.length; i++) {
    const cell = grid.children[i] as HTMLElement;
    if (!cell) continue;

    const isSelected = i === targetHour;
    const state = cellStateMap.get(cell);
    const borderClass = state?.borderClass || "border-terminal-border";
    const bgClass = "bg-terminal-surface";

    if (isSelected) {
      cell.className = `relative flex flex-col items-center justify-center h-11.5 px-0.5 rounded border cursor-pointer transition select-none hover:bg-terminal-surfaceHover ${bgClass} z-10 border-terminal-accent ring-1 ring-terminal-accent ring-inset`;
      if (cell.classList) {
        cell.classList.remove("z-0");
        cell.classList.add(
          "z-10",
          "border-terminal-accent",
          "ring-1",
          "ring-terminal-accent",
          "ring-inset",
        );
      }
      let dot = cell.querySelector ? cell.querySelector(".heatmap-current-dot") : null;
      if (!dot && cell.innerHTML && !cell.innerHTML.includes("heatmap-current-dot")) {
        const dotEl = document.createElement("span");
        dotEl.className =
          "heatmap-current-dot absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-terminal-accent pointer-events-none";
        cell.appendChild(dotEl);
      }
    } else {
      cell.className = `relative flex flex-col items-center justify-center h-11.5 px-0.5 rounded border cursor-pointer transition select-none hover:bg-terminal-surfaceHover ${bgClass} z-0 ${borderClass}`;
      if (cell.classList) {
        cell.classList.remove(
          "z-10",
          "border-terminal-accent",
          "ring-1",
          "ring-terminal-accent",
          "ring-inset",
        );
        cell.classList.add("z-0");
      }
      const dot = cell.querySelector ? cell.querySelector(".heatmap-current-dot") : null;
      if (dot) {
        if (typeof (dot as any).remove === "function") {
          (dot as any).remove();
        } else if (typeof cell.removeChild === "function") {
          cell.removeChild(dot);
        }
      }
    }
  }
}
