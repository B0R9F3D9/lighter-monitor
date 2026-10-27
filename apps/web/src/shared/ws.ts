import { CONFIG } from "./config";

export interface WsOrderBookData {
  asks?: Array<{ price: string | number; size: string | number }>;
  bids?: Array<{ price: string | number; size: string | number }>;
  offset?: number;
}

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

// Pre-serialized static payloads (0 runtime allocations)
const PING_PAYLOAD = '{"type":"ping"}';
const PONG_PAYLOAD = '{"type":"pong"}';
const PING_INTERVAL_MS = 25_000;
const STALE_TIMEOUT_MS = 40_000;
const MIN_RECONNECT_MS = 2_000;
const MAX_RECONNECT_MS = 30_000;

export class WebSocketManager {
  private coreWs: WebSocket | null = null;
  private rhWs: WebSocket | null = null;
  private corePingTimer: ReturnType<typeof setInterval> | null = null;
  private rhPingTimer: ReturnType<typeof setInterval> | null = null;
  private coreReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private rhReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private coreReconnectDelay = MIN_RECONNECT_MS;
  private rhReconnectDelay = MIN_RECONNECT_MS;

  public lastCoreMsgAt = 0;
  public lastRhMsgAt = 0;
  private lastWsErrLog = 0;

  private subscribedCore = new Set<number>();
  private subscribedRh = new Set<number>();

  // Channel string parse cache ("order_book:123" -> 123) to avoid slice + Number parsing per tick
  private channelToMarketId = new Map<string, number>();

  constructor(private callbacks: WsCallbacks) {}

  private logWsError(prefix: string, err: unknown): void {
    const now = performance.now();
    if (now - this.lastWsErrLog > 5000) {
      this.lastWsErrLog = now;
      console.error(`[WS] ${prefix}:`, err);
    }
  }

  private getMarketIdFromChannel(ch: string): number {
    let mid = this.channelToMarketId.get(ch);
    if (mid === undefined) {
      mid = Number(ch.slice(11));
      if (!Number.isNaN(mid)) {
        this.channelToMarketId.set(ch, mid);
      }
    }
    return mid;
  }

  public connectAll(): void {
    this.connectCore();
    this.connectRh();
  }

  public disconnectAll(): void {
    this.cleanupCore();
    this.cleanupRh();
  }

  private cleanupCore(): void {
    if (this.corePingTimer) {
      clearInterval(this.corePingTimer);
      this.corePingTimer = null;
    }
    if (this.coreReconnectTimer) {
      clearTimeout(this.coreReconnectTimer);
      this.coreReconnectTimer = null;
    }
    if (this.coreWs) {
      const oldWs = this.coreWs;
      this.coreWs = null; // Detach reference first so old close handler does not trigger reconnect
      try {
        oldWs.close();
      } catch {}
    }
  }

  private cleanupRh(): void {
    if (this.rhPingTimer) {
      clearInterval(this.rhPingTimer);
      this.rhPingTimer = null;
    }
    if (this.rhReconnectTimer) {
      clearTimeout(this.rhReconnectTimer);
      this.rhReconnectTimer = null;
    }
    if (this.rhWs) {
      const oldWs = this.rhWs;
      this.rhWs = null;
      try {
        oldWs.close();
      } catch {}
    }
  }

  public connectCore(): void {
    this.cleanupCore();

    const ws = new WebSocket(CONFIG.CORE_WS_URL);
    this.coreWs = ws;

    ws.addEventListener("open", () => {
      if (this.coreWs !== ws) return;

      this.lastCoreMsgAt = Date.now();
      this.callbacks.onCoreOpen?.();

      for (const mid of this.subscribedCore) {
        try {
          ws.send(`{"type":"subscribe","channel":"order_book/${mid}"}`);
        } catch {}
      }

      this.corePingTimer = setInterval(() => {
        if (this.coreWs !== ws || ws.readyState !== WebSocket.OPEN) return;

        // Guard against half-open / dead TCP connections
        if (Date.now() - this.lastCoreMsgAt > STALE_TIMEOUT_MS) {
          this.logWsError("core ws stale timeout, reconnecting", new Error("Timeout"));
          this.connectCore();
          return;
        }

        try {
          ws.send(PING_PAYLOAD);
        } catch {}
      }, PING_INTERVAL_MS);
    });

    ws.addEventListener("message", (e: MessageEvent) => {
      if (this.coreWs !== ws) return;

      this.lastCoreMsgAt = Date.now();
      this.coreReconnectDelay = MIN_RECONNECT_MS; // Reset backoff only on actual payload traffic

      const raw = e.data;
      if (typeof raw !== "string") return;

      // Fast-path for ping/pong/control frames avoiding JSON.parse on high-throughput stream
      if (raw.length < 50) {
        if (raw.includes('"ping"')) {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(PONG_PAYLOAD);
            } catch {}
          }
          return;
        }
        if (
          raw.includes('"pong"') ||
          raw.includes('"unsubscribed"') ||
          raw.includes('"connected"')
        ) {
          return;
        }
      }

      try {
        const d = JSON.parse(raw);
        const ch = d.channel;
        if (typeof ch === "string" && ch.startsWith("order_book:") && d.order_book) {
          const mid = this.getMarketIdFromChannel(ch);
          if (!this.subscribedCore.has(mid)) return;

          const isSnapshot = d.type === "subscribed/order_book";
          this.callbacks.onCoreBookUpdate?.(
            mid,
            d.order_book,
            isSnapshot,
            d.offset ?? d.order_book?.offset ?? 0,
          );
        }
      } catch (err) {
        this.logWsError("core message parse error", err);
      }
    });

    ws.addEventListener("close", () => {
      // Ignore close events from superseded socket instances
      if (this.coreWs !== ws) return;

      if (this.corePingTimer) {
        clearInterval(this.corePingTimer);
        this.corePingTimer = null;
      }
      this.coreWs = null;
      this.callbacks.onCoreClose?.();

      // Add jitter (up to 20%) to avoid synchronized reconnect thundering herd
      const jitter = Math.random() * 0.2 * this.coreReconnectDelay;
      const delay = this.coreReconnectDelay + jitter;
      this.coreReconnectDelay = Math.min(this.coreReconnectDelay * 2, MAX_RECONNECT_MS);
      this.coreReconnectTimer = setTimeout(() => this.connectCore(), delay);
    });

    ws.addEventListener("error", (err) => {
      if (this.coreWs !== ws) return;
      this.logWsError("core ws error", err);
      try {
        ws.close();
      } catch {}
    });
  }

  public connectRh(): void {
    this.cleanupRh();

    const ws = new WebSocket(CONFIG.RH_WS_URL);
    this.rhWs = ws;

    ws.addEventListener("open", () => {
      if (this.rhWs !== ws) return;

      this.lastRhMsgAt = Date.now();
      this.callbacks.onRhOpen?.();

      for (const mid of this.subscribedRh) {
        try {
          ws.send(`{"type":"subscribe","channel":"order_book/${mid}"}`);
        } catch {}
      }

      this.rhPingTimer = setInterval(() => {
        if (this.rhWs !== ws || ws.readyState !== WebSocket.OPEN) return;

        if (Date.now() - this.lastRhMsgAt > STALE_TIMEOUT_MS) {
          this.logWsError("rh ws stale timeout, reconnecting", new Error("Timeout"));
          this.connectRh();
          return;
        }

        try {
          ws.send(PING_PAYLOAD);
        } catch {}
      }, PING_INTERVAL_MS);
    });

    ws.addEventListener("message", (e: MessageEvent) => {
      if (this.rhWs !== ws) return;

      this.lastRhMsgAt = Date.now();
      this.rhReconnectDelay = MIN_RECONNECT_MS;

      const raw = e.data;
      if (typeof raw !== "string") return;

      if (raw.length < 50) {
        if (raw.includes('"ping"')) {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(PONG_PAYLOAD);
            } catch {}
          }
          return;
        }
        if (
          raw.includes('"pong"') ||
          raw.includes('"unsubscribed"') ||
          raw.includes('"connected"')
        ) {
          return;
        }
      }

      try {
        const d = JSON.parse(raw);
        const ch = d.channel;
        if (typeof ch === "string" && ch.startsWith("order_book:") && d.order_book) {
          const mid = this.getMarketIdFromChannel(ch);
          if (!this.subscribedRh.has(mid)) return;

          const isSnapshot = d.type === "subscribed/order_book";
          this.callbacks.onRhBookUpdate?.(
            mid,
            d.order_book,
            isSnapshot,
            d.offset ?? d.order_book?.offset ?? 0,
          );
        }
      } catch (err) {
        this.logWsError("rh message parse error", err);
      }
    });

    ws.addEventListener("close", () => {
      if (this.rhWs !== ws) return;

      if (this.rhPingTimer) {
        clearInterval(this.rhPingTimer);
        this.rhPingTimer = null;
      }
      this.rhWs = null;
      this.callbacks.onRhClose?.();

      const jitter = Math.random() * 0.2 * this.rhReconnectDelay;
      const delay = this.rhReconnectDelay + jitter;
      this.rhReconnectDelay = Math.min(this.rhReconnectDelay * 2, MAX_RECONNECT_MS);
      this.rhReconnectTimer = setTimeout(() => this.connectRh(), delay);
    });

    ws.addEventListener("error", (err) => {
      if (this.rhWs !== ws) return;
      this.logWsError("rh ws error", err);
      try {
        ws.close();
      } catch {}
    });
  }

  public subscribeCore(marketId: number): void {
    if (this.subscribedCore.has(marketId)) return;
    this.subscribedCore.add(marketId);
    if (this.coreWs && this.coreWs.readyState === WebSocket.OPEN) {
      try {
        this.coreWs.send(`{"type":"subscribe","channel":"order_book/${marketId}"}`);
      } catch {}
    }
  }

  public unsubscribeCore(marketId: number): void {
    if (!this.subscribedCore.delete(marketId)) return;
    if (this.coreWs && this.coreWs.readyState === WebSocket.OPEN) {
      try {
        this.coreWs.send(`{"type":"unsubscribe","channel":"order_book/${marketId}"}`);
      } catch {}
    }
  }

  public isCoreSubscribed(marketId: number): boolean {
    return this.subscribedCore.has(marketId);
  }

  public subscribeRh(marketId: number): void {
    if (this.subscribedRh.has(marketId)) return;
    this.subscribedRh.add(marketId);
    if (this.rhWs && this.rhWs.readyState === WebSocket.OPEN) {
      try {
        this.rhWs.send(`{"type":"subscribe","channel":"order_book/${marketId}"}`);
      } catch {}
    }
  }

  public unsubscribeRh(marketId: number): void {
    if (!this.subscribedRh.delete(marketId)) return;
    if (this.rhWs && this.rhWs.readyState === WebSocket.OPEN) {
      try {
        this.rhWs.send(`{"type":"unsubscribe","channel":"order_book/${marketId}"}`);
      } catch {}
    }
  }

  public isRhSubscribed(marketId: number): boolean {
    return this.subscribedRh.has(marketId);
  }

  public getSubscribedCoreCount(): number {
    return this.subscribedCore.size;
  }

  public getSubscribedRhCount(): number {
    return this.subscribedRh.size;
  }
}
