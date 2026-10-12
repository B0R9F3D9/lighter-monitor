export class Tracer {
  private startTime = performance.now();
  private lastMark = performance.now();
  private spans: Record<string, number> = {};
  private counts: Record<string, number> = {};
  private metadata: Record<string, any> = {};

  constructor(
    private name: string,
    initialMetadata: Record<string, any> = {},
  ) {
    this.metadata = { ...initialMetadata };
  }

  set(key: string, value: any): this {
    this.metadata[key] = value;
    return this;
  }

  addSpan(spanName: string, duration: number, count = 1): void {
    this.spans[spanName] = (this.spans[spanName] || 0) + duration;
    this.counts[spanName] = (this.counts[spanName] || 0) + count;
  }

  mark(spanName: string): number {
    const now = performance.now();
    const duration = now - this.lastMark;
    this.spans[spanName] = (this.spans[spanName] || 0) + duration;
    this.counts[spanName] = (this.counts[spanName] || 0) + 1;
    this.lastMark = now;
    return duration;
  }

  measureSync<T>(spanName: string, fn: () => T): T {
    const start = performance.now();
    try {
      return fn();
    } finally {
      const duration = performance.now() - start;
      this.spans[spanName] = (this.spans[spanName] || 0) + duration;
      this.counts[spanName] = (this.counts[spanName] || 0) + 1;
      this.lastMark = performance.now();
    }
  }

  async measure<T>(spanName: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      const duration = performance.now() - start;
      this.spans[spanName] = (this.spans[spanName] || 0) + duration;
      this.counts[spanName] = (this.counts[spanName] || 0) + 1;
      this.lastMark = performance.now();
    }
  }

  getSpans(): Record<string, number> {
    return { ...this.spans };
  }

  getCounts(): Record<string, number> {
    return { ...this.counts };
  }

  getTotalMs(): number {
    return performance.now() - this.startTime;
  }

  end(thresholdMs = 15): void {
    const totalMs = performance.now() - this.startTime;
    // Log only if execution duration exceeded the threshold (e.g. frame > 15ms)
    if (totalMs >= thresholdMs) {
      const formattedSpans: Record<string, string> = {};
      for (const [k, v] of Object.entries(this.spans)) {
        formattedSpans[k] = `${v.toFixed(3)}ms (${this.counts[k] || 1}x)`;
      }

      console.warn(
        `[TRACE:${this.name}] Total: ${totalMs.toFixed(2)}ms`,
        formattedSpans,
        this.metadata,
      );
    }
  }
}
