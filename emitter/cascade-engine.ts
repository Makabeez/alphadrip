/**
 * AlphaDrip Cascade Engine
 *
 * Detects directional liquidation-proxy cascades on Hyperliquid BTC.
 *
 * The thesis: public HL liquidations aren't on a WebSocket feed, but when HL's
 * liquidation engine dumps positions, it market-sells/market-buys through the
 * order book, which shows up as a distinctive pattern on the public trades feed:
 *
 *   1. Elevated volume (> 2.5× the 5-min rolling average)
 *   2. High directional bias (> 70% one-sided)
 *   3. A cluster of aggressive fills in a tight window
 *
 * When all three are true in a 30s window, we fire a cascade signal with a
 * conviction score (0-1). Each signal is a billable event.
 */

import WebSocket from "ws";
import { EventEmitter } from "node:events";

export interface CascadeSignal {
  id: string; // cascade-<ms>-<side>
  timestamp: number; // ms epoch, when detected
  symbol: "BTC";
  side: "LONG_LIQ" | "SHORT_LIQ"; // LONG_LIQ = longs getting liquidated (price falling)
  price: number; // last trade px at detection
  window_notional: number; // $ traded in the 30s window
  directional_bias: number; // 0-1 (1.0 = fully one-sided)
  volume_ratio: number; // window_vol / 5min_avg
  conviction: number; // 0-1 composite score
  trades_in_window: number;
  next_levels?: {
    // speculative target levels for the consumer
    tp: number;
    stop: number;
  };
}

interface TradeEvent {
  coin: string;
  side: "A" | "B"; // A = sell (hit bid), B = buy (lift offer)
  px: string;
  sz: string;
  time: number;
  tid: number;
}

interface TradeRecord {
  time: number;
  side: "A" | "B";
  px: number;
  notional: number;
}

export class CascadeEngine extends EventEmitter {
  private ws?: WebSocket;
  private trades: TradeRecord[] = [];
  private lastSignal: CascadeSignal | null = null;
  private lastSignalTime = 0;
  private readonly WINDOW_MS = 30_000; // 30s rolling window
  private readonly BASELINE_MS = 5 * 60_000; // 5min baseline
  private readonly MIN_COOLDOWN_MS = 5_000; // min gap between signals
  private readonly WS_URL = "wss://api.hyperliquid.xyz/ws";

  start() {
    this.connect();
  }

  private connect() {
    console.log("[engine] connecting to HL WebSocket...");
    this.ws = new WebSocket(this.WS_URL);

    this.ws.on("open", () => {
      console.log("[engine] HL WS connected, subscribing to BTC trades");
      this.ws?.send(
        JSON.stringify({
          method: "subscribe",
          subscription: { type: "trades", coin: "BTC" },
        })
      );
    });

    this.ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.channel === "trades" && Array.isArray(msg.data)) {
          for (const t of msg.data as TradeEvent[]) {
            this.ingest(t);
          }
          this.evaluate();
        }
      } catch (e) {
        console.error("[engine] parse error:", e);
      }
    });

    this.ws.on("close", () => {
      console.warn("[engine] HL WS closed, reconnecting in 2s");
      setTimeout(() => this.connect(), 2_000);
    });

    this.ws.on("error", (e) => {
      console.error("[engine] HL WS error:", e.message);
    });
  }

  private ingest(t: TradeEvent) {
    const px = parseFloat(t.px);
    const sz = parseFloat(t.sz);
    this.trades.push({
      time: t.time,
      side: t.side,
      px,
      notional: px * sz,
    });

    // Trim old trades (keep baseline window + a little buffer)
    const cutoff = Date.now() - this.BASELINE_MS - 10_000;
    while (this.trades.length > 0 && this.trades[0].time < cutoff) {
      this.trades.shift();
    }
  }

  private evaluate() {
    const now = Date.now();
    if (now - this.lastSignalTime < this.MIN_COOLDOWN_MS) return;

    const windowStart = now - this.WINDOW_MS;
    const baselineStart = now - this.BASELINE_MS;

    const window = this.trades.filter((t) => t.time >= windowStart);
    const baseline = this.trades.filter(
      (t) => t.time >= baselineStart && t.time < windowStart
    );

    if (window.length < 20 || baseline.length < 50) return; // need enough data

    const windowNotional = window.reduce((s, t) => s + t.notional, 0);
    const baselineNotional = baseline.reduce((s, t) => s + t.notional, 0);

    // Baseline is ~4.5min (after excluding the 30s window), so per-30s avg:
    const baselinePerWindow =
      baselineNotional / ((this.BASELINE_MS - this.WINDOW_MS) / this.WINDOW_MS);
    if (baselinePerWindow === 0) return;

    const volumeRatio = windowNotional / baselinePerWindow;

    // Directional bias — side "A" = aggressive sell (longs being hit)
    const sellNotional = window
      .filter((t) => t.side === "A")
      .reduce((s, t) => s + t.notional, 0);
    const buyNotional = windowNotional - sellNotional;
    const sellBias = sellNotional / windowNotional;
    const dominantSide: "LONG_LIQ" | "SHORT_LIQ" =
      sellBias >= 0.5 ? "LONG_LIQ" : "SHORT_LIQ";
    const directionalBias = Math.max(sellBias, 1 - sellBias);

    // Thresholds — tuned for "interesting but not constant" firing
    const VOL_THRESHOLD = 2.5;
    const BIAS_THRESHOLD = 0.7;

    if (volumeRatio < VOL_THRESHOLD || directionalBias < BIAS_THRESHOLD) return;

    // Conviction = weighted composite
    const volScore = Math.min(volumeRatio / 5, 1); // caps at 5x
    const biasScore = (directionalBias - 0.5) * 2; // 0.5->0, 1.0->1
    const conviction = volScore * 0.6 + biasScore * 0.4;

    const lastPx = window[window.length - 1].px;
    const signal: CascadeSignal = {
      id: `cascade-${now}-${dominantSide}`,
      timestamp: now,
      symbol: "BTC",
      side: dominantSide,
      price: lastPx,
      window_notional: Math.round(windowNotional),
      directional_bias: Number(directionalBias.toFixed(3)),
      volume_ratio: Number(volumeRatio.toFixed(2)),
      conviction: Number(conviction.toFixed(3)),
      trades_in_window: window.length,
      next_levels:
        dominantSide === "LONG_LIQ"
          ? { tp: lastPx * 0.997, stop: lastPx * 1.002 }
          : { tp: lastPx * 1.003, stop: lastPx * 0.998 },
    };

    this.lastSignal = signal;
    this.lastSignalTime = now;
    console.log(
      `[engine] 🔥 CASCADE: ${signal.side} @ $${signal.price.toFixed(
        0
      )} | vol ${signal.volume_ratio}x | bias ${signal.directional_bias} | conv ${signal.conviction}`
    );
    this.emit("signal", signal);
  }

  getLatest(): CascadeSignal | null {
    return this.lastSignal;
  }
}
