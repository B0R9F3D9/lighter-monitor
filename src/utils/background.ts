import { AsyncLocalStorage } from "node:async_hooks";

export const executionContextStorage = new AsyncLocalStorage<ExecutionContext>();

export function runInBackground(promise: Promise<any>): void {
  const ctx = executionContextStorage.getStore();
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(promise.catch((err) => console.error("[runInBackground error]", err)));
  } else {
    promise.catch((err) => console.error("[runInBackground error]", err));
  }
}
