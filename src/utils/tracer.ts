export class Tracer {
  private startTime: number = Date.now();
  private lastMark: number = Date.now();
  private spans: Record<string, number> = {};
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

  mark(spanName: string): number {
    const now = Date.now();
    const duration = now - this.lastMark;
    this.spans[spanName] = (this.spans[spanName] || 0) + duration;
    this.lastMark = now;
    return duration;
  }

  async measure<T>(spanName: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      const duration = Date.now() - start;
      this.spans[spanName] = (this.spans[spanName] || 0) + duration;
      this.lastMark = Date.now();
    }
  }

  measureSync<T>(spanName: string, fn: () => T): T {
    const start = Date.now();
    try {
      return fn();
    } finally {
      const duration = Date.now() - start;
      this.spans[spanName] = (this.spans[spanName] || 0) + duration;
      this.lastMark = Date.now();
    }
  }

  getSpans(): Record<string, number> {
    return { ...this.spans };
  }

  getTotalMs(): number {
    return Date.now() - this.startTime;
  }

  end(): void {
    const totalMs = Date.now() - this.startTime;
    try {
      console.log(
        JSON.stringify({
          event: "trace",
          name: this.name,
          total_ms: totalMs,
          spans: this.spans,
          ...this.metadata,
        }),
      );
    } catch {}
  }
}
