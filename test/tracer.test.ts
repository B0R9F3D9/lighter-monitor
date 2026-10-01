import { describe, expect, it } from "bun:test";
import { Tracer } from "../src/utils/tracer";

describe("Tracer", () => {
  it("should record marks and measures with sub-millisecond precision and counts", async () => {
    const trace = new Tracer("test_trace", { testId: 123 });
    trace.set("extra", "value");

    await new Promise((r) => setTimeout(r, 10));
    trace.mark("step_1");

    const result = await trace.measure("async_step", async () => {
      await new Promise((r) => setTimeout(r, 15));
      return 42;
    });

    expect(result).toBe(42);

    const syncResult = trace.measureSync("sync_step", () => {
      return "ok";
    });
    expect(syncResult).toBe("ok");

    trace.addSpan("manual_calc", 2.5, 5);

    const spans = trace.getSpans();
    const counts = trace.getCounts();

    expect(spans.step_1).toBeGreaterThanOrEqual(8);
    expect(counts.step_1).toBe(1);

    expect(spans.async_step).toBeGreaterThanOrEqual(10);
    expect(counts.async_step).toBe(1);

    expect(spans.sync_step).toBeGreaterThanOrEqual(0);
    expect(counts.sync_step).toBe(1);

    expect(spans.manual_calc).toBe(2.5);
    expect(counts.manual_calc).toBe(5);

    expect(trace.getTotalMs()).toBeGreaterThanOrEqual(20);

    // end should not throw
    expect(() => trace.end()).not.toThrow();
  });

  it("should filter logs based on thresholdMs in end()", () => {
    const trace = new Tracer("threshold_test", { run: 1 });
    trace.mark("short_operation");

    let warnCalled = false;
    let loggedMessage = "";
    let loggedSpans: Record<string, string> | undefined;

    const originalWarn = console.warn;
    console.warn = (msg: string, spans?: any) => {
      warnCalled = true;
      loggedMessage = msg;
      loggedSpans = spans;
    };

    try {
      // Very high threshold should NOT log
      trace.end(1000);
      expect(warnCalled).toBe(false);

      // Low threshold (0ms) SHOULD log
      trace.end(0);
      expect(warnCalled).toBe(true);
      expect(loggedMessage).toContain("[TRACE:threshold_test]");
      expect(loggedSpans?.short_operation).toBeDefined();
      expect(loggedSpans?.short_operation).toContain("(1x)");
    } finally {
      console.warn = originalWarn;
    }
  });

  it("should accumulate durations and counts on repeated calls to mark or addSpan", () => {
    const trace = new Tracer("aggregation_test");

    trace.addSpan("loop_item", 1.2, 1);
    trace.addSpan("loop_item", 2.3, 1);

    expect(trace.getSpans().loop_item).toBeCloseTo(3.5, 4);
    expect(trace.getCounts().loop_item).toBe(2);
  });
});
