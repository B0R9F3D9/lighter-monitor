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

    cellStateMap.set(cell, { bucket: b, isCurrent, onHourClick });

    let bgClass = "bg-terminal-surface";
    let borderClass = "border-terminal-border";
    let textClass = "text-terminal-secondary";

    if (b.sampleCount > 0) {
      if (b.scoreNormalized <= 0.25) {
        bgClass = "bg-terminal-emeraldMuted";
        borderClass = "border-terminal-emerald/40";
        textClass = "text-terminal-emerald";
      } else if (b.scoreNormalized <= 0.55) {
        bgClass = "bg-terminal-surfaceHover";
        borderClass = "border-terminal-borderSubtle";
        textClass = "text-terminal-primary";
      } else if (b.scoreNormalized <= 0.75) {
        bgClass = "bg-terminal-amberMuted";
        borderClass = "border-terminal-amber/40";
        textClass = "text-terminal-amber";
      } else {
        bgClass = "bg-terminal-coralMuted";
        borderClass = "border-terminal-coral/50";
        textClass = "text-terminal-coral";
      }
    } else {
      bgClass = "bg-terminal-surface/30";
      borderClass = "border-terminal-border/30";
      textClass = "text-terminal-muted";
    }

    const ringClass = isCurrent ? "ring-1 ring-terminal-accent" : "";
    cell.className = `relative flex flex-col items-center justify-center h-11.5 px-0.5 rounded border cursor-pointer transition select-none ${ringClass} ${bgClass} ${borderClass}`;

    const sign = b.avgBasisUsd > 0 ? "+" : "";
    const basisLabel = b.sampleCount > 0 ? `${sign}$${b.avgBasisUsd.toFixed(2)}` : "—";

    cell.innerHTML = `
      <div class="text-[10px] font-bold ${textClass} tabular-nums">${b.label}</div>
      <div class="text-[9px] font-mono ${textClass} tabular-nums mt-0.5 truncate w-full text-center">${basisLabel}</div>
      ${isCurrent ? '<span class="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-terminal-accent"></span>' : ""}
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
