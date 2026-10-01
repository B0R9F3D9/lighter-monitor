import { CONFIG } from "./config";
import type { WsOrderBookData } from "./orderbook";

export interface WsCallbacks {
  onCoreOpen?: () => void;
  onCoreClose?: () => void;
  onRhOpen?: () => void;
  onRhClose?: () => void;
  onCoreBookUpdate?: (
    marketId: number,
    data: WsOrderBookData,
    isSnapshot: boolean,
    offset: number,
  ) => void;
  onRhBookUpdate?: (
    marketId: number,
    data: WsOrderBookData,
    isSnapshot: boolean,
    offset: number,
  ) => void;
}

export class WebSocketManager {
  private coreWs: WebSocket | null = null;
  private rhWs: WebSocket | null = null;
  private corePingTimer: ReturnType<typeof setInterval> | null = null;
  private rhPingTimer: ReturnType<typeof setInterval> | null = null;
  private coreReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private rhReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private coreReconnectDelay = 2000;
  private rhReconnectDelay = 2000;

  public lastCoreMsgAt = 0;
  public lastRhMsgAt = 0;
  private lastWsErrLog = 0;

  constructor(private callbacks: WsCallbacks) {}

  private logWsError(prefix: string, err: unknown): void {
    const now = performance.now();
    if (now - this.lastWsErrLog > 5000) {
      this.lastWsErrLog = now;
      console.error(`[WS] ${prefix}:`, err);
    }
  }

  public connectAll(): void {
    this.connectCore();
    this.connectRh();
  }

  public connectCore(): void {
    if (this.corePingTimer) {
      clearInterval(this.corePingTimer);
      this.corePingTimer = null;
    }
    if (this.coreReconnectTimer) {
      clearTimeout(this.coreReconnectTimer);
      this.coreReconnectTimer = null;
    }
    if (this.coreWs) {
      try {
        this.coreWs.close();
      } catch {}
      this.coreWs = null;
    }

    const ws = new WebSocket(CONFIG.CORE_WS_URL);
    this.coreWs = ws;

    ws.addEventListener("open", () => {
      this.lastCoreMsgAt = Date.now();
      this.coreReconnectDelay = 2000;
      this.callbacks.onCoreOpen?.();

      this.corePingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ type: "ping" }));
          } catch {}
        }
      }, 25000);
    });

    ws.addEventListener("message", (e: MessageEvent) => {
      this.lastCoreMsgAt = Date.now();
      try {
        const d = JSON.parse(e.data);
        if (d.type === "ping") {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "pong" }));
          }
          return;
        }
        const ch = d.channel;
        if (typeof ch === "string" && ch.startsWith("order_book:") && d.order_book) {
          const mid = Number(ch.slice(11));
          const isSnapshot = d.type === "subscribed/order_book";
          this.callbacks.onCoreBookUpdate?.(
            mid,
            d.order_book,
            isSnapshot,
            d.offset || d.order_book?.offset || 0,
          );
        }
      } catch (err) {
        this.logWsError("core message parse error", err);
      }
    });

    ws.addEventListener("close", () => {
      if (this.corePingTimer) {
        clearInterval(this.corePingTimer);
        this.corePingTimer = null;
      }
      this.callbacks.onCoreClose?.();

      const delay = this.coreReconnectDelay;
      this.coreReconnectDelay = Math.min(this.coreReconnectDelay * 2, 30000);
      this.coreReconnectTimer = setTimeout(() => this.connectCore(), delay);
    });

    ws.addEventListener("error", (err) => {
      this.logWsError("core ws error", err);
      try {
        ws.close();
      } catch {}
    });
  }

  public connectRh(): void {
    if (this.rhPingTimer) {
      clearInterval(this.rhPingTimer);
      this.rhPingTimer = null;
    }
    if (this.rhReconnectTimer) {
      clearTimeout(this.rhReconnectTimer);
      this.rhReconnectTimer = null;
    }
    if (this.rhWs) {
      try {
        this.rhWs.close();
      } catch {}
      this.rhWs = null;
    }

    const ws = new WebSocket(CONFIG.RH_WS_URL);
    this.rhWs = ws;

    ws.addEventListener("open", () => {
      this.lastRhMsgAt = Date.now();
      this.rhReconnectDelay = 2000;
      this.callbacks.onRhOpen?.();

      this.rhPingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ type: "ping" }));
          } catch {}
        }
      }, 25000);
    });

    ws.addEventListener("message", (e: MessageEvent) => {
      this.lastRhMsgAt = Date.now();
      try {
        const d = JSON.parse(e.data);
        if (d.type === "ping") {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "pong" }));
          }
          return;
        }
        const ch = d.channel;
        if (typeof ch === "string" && ch.startsWith("order_book:") && d.order_book) {
          const mid = Number(ch.slice(11));
          const isSnapshot = d.type === "subscribed/order_book";
          this.callbacks.onRhBookUpdate?.(
            mid,
            d.order_book,
            isSnapshot,
            d.offset || d.order_book?.offset || 0,
          );
        }
      } catch (err) {
        this.logWsError("rh message parse error", err);
      }
    });

    ws.addEventListener("close", () => {
      if (this.rhPingTimer) {
        clearInterval(this.rhPingTimer);
        this.rhPingTimer = null;
      }
      this.callbacks.onRhClose?.();

      const delay = this.rhReconnectDelay;
      this.rhReconnectDelay = Math.min(this.rhReconnectDelay * 2, 30000);
      this.rhReconnectTimer = setTimeout(() => this.connectRh(), delay);
    });

    ws.addEventListener("error", (err) => {
      this.logWsError("rh ws error", err);
      try {
        ws.close();
      } catch {}
    });
  }

  public subscribeCore(marketId: number): void {
    if (this.coreWs && this.coreWs.readyState === WebSocket.OPEN) {
      this.coreWs.send(JSON.stringify({ type: "subscribe", channel: `order_book/${marketId}` }));
    }
  }

  public subscribeRh(marketId: number): void {
    if (this.rhWs && this.rhWs.readyState === WebSocket.OPEN) {
      this.rhWs.send(JSON.stringify({ type: "subscribe", channel: `order_book/${marketId}` }));
    }
  }
}
