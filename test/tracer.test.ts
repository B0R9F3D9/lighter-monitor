import { describe, expect, it } from "bun:test";
import { Tracer } from "../src/utils/tracer";

describe("Tracer", () => {
  it("should record marks and measures correctly", async () => {
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

    const spans = trace.getSpans();
    expect(spans.step_1).toBeGreaterThanOrEqual(8);
    expect(spans.async_step).toBeGreaterThanOrEqual(10);
    expect(trace.getTotalMs()).toBeGreaterThanOrEqual(20);

    // end should not throw
    expect(() => trace.end()).not.toThrow();
  });
});
