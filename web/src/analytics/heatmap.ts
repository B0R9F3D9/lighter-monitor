import type { HourlyBucketStats } from "./types";

export function renderHourlyHeatmap(
  container: HTMLElement,
  buckets: HourlyBucketStats[],
  currentHourLocal: number,
  onHourClick?: (hour: number) => void,
): void {
  container.innerHTML = "";

  const grid = document.createElement("div");
  grid.className = "grid grid-cols-6 sm:grid-cols-12 md:grid-cols-24 gap-1 w-full";

  for (const b of buckets) {
    const isCurrent = b.hour === currentHourLocal;
    const cell = document.createElement("div");
    cell.className = `group relative flex flex-col items-center justify-center py-2 px-1 rounded border cursor-pointer transition select-none ${
      isCurrent ? "ring-1 ring-terminal-accent" : ""
    }`;

    // Color interpolation:
    // score 0.0 -> bg-terminal-emeraldMuted border-terminal-emerald/40 text-terminal-emerald
    // score 0.5 -> bg-terminal-surface border-terminal-border text-terminal-secondary
    // score 1.0 -> bg-terminal-coralMuted border-terminal-coral/40 text-terminal-coral
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

    cell.className += ` ${bgClass} ${borderClass}`;

    const sign = b.avgBasisUsd > 0 ? "+" : "";
    const basisLabel =
      b.sampleCount > 0 ? `${sign}$${b.avgBasisUsd.toFixed(2)}` : "—";

    cell.innerHTML = `
      <div class="text-[10px] font-bold ${textClass} tabular-nums">${b.label}</div>
      <div class="text-[9px] font-mono ${textClass} tabular-nums mt-0.5 truncate w-full text-center">${basisLabel}</div>
      ${isCurrent ? '<span class="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-terminal-accent"></span>' : ""}

      <!-- Tooltip -->
      <div class="absolute bottom-full mb-1.5 left-1/2 -translate-x-1/2 hidden group-hover:block z-30 pointer-events-none whitespace-nowrap bg-terminal-bg border border-terminal-border px-2.5 py-1.5 rounded shadow-lg text-[10px] font-mono text-terminal-secondary">
        <div class="font-bold text-white mb-0.5">${b.label}:00 - ${String((b.hour + 1) % 24).padStart(2, "0")}:00 ${isCurrent ? "(Current)" : ""}</div>
        <div class="flex justify-between gap-3"><span>Avg Basis:</span> <span class="text-white font-bold tabular-nums">${sign}$${b.avgBasisUsd.toFixed(3)} (${sign}${b.avgBasisBps.toFixed(1)} bps)</span></div>
        <div class="flex justify-between gap-3"><span>Range:</span> <span class="tabular-nums">$${b.minBasisUsd.toFixed(2)} .. $${b.maxBasisUsd.toFixed(2)}</span></div>
        <div class="flex justify-between gap-3 text-terminal-muted"><span>Samples:</span> <span class="tabular-nums">${b.sampleCount}</span></div>
      </div>
    `;

    if (onHourClick) {
      cell.addEventListener("click", () => onHourClick(b.hour));
    }

    grid.appendChild(cell);
  }

  container.appendChild(grid);
}
