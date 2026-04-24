# 🩸 AlphaDrip

**Pay-per-alpha. Sub-cent trading signals settled on Arc.**

Submission for the **Agentic Economy on Arc** hackathon — April 2026
Track: **Best Gateway-Based Micropayments Integration**

---

## The problem

Every trader has paid $200/month for a Telegram signal group that posted two trades. You paid for silence.

Traditional signal distribution is broken:

- **Subscription gates** force you to pay for idle weeks
- **Gas fees** make per-signal billing impossible (a $0.003 signal paying $0.50 in gas = -16,000% margin)
- **No accountability** — the emitter gets paid whether or not signals fire

## The fix

AlphaDrip turns each trading signal into an **x402-paid API call**. Subscribers pay **$0.003 per signal** via Circle Nanopayments. Emitters earn on delivery. Circle Gateway batches the micropayments into periodic Arc settlements — gas-free, sub-second, and economically viable at this price point for the first time.

The demo emitter streams **liquidation-cascade signals on BTC** detected from the Hyperliquid public trade tape. It fires 20–100 times per hour during volatility — exactly the high-frequency regime nanopayments were built for.

---

## ✅ Hackathon requirements

| Requirement | AlphaDrip |
|---|---|
| **≤ $0.01 per action** | $0.003 per signal — **3× under the limit** |
| **50+ on-chain transactions in demo** | A 3-minute demo during BTC volatility delivers 60–90 paid calls, batched into 3–5 Arc settlements (see `docs/demo.mp4`) |
| **Margin explanation** | At $0.003/call, Ethereum gas (~$0.50) would be **166× the signal price**. On Base (~$0.01), it's still **3× revenue**. Only Arc + Circle Gateway's off-chain batching makes this viable. |

---

## Architecture

```
┌─────────────────┐  HL WS   ┌──────────────────┐
│  Hyperliquid    │─────────▶│  Cascade Engine  │
│  BTC trade tape │           │  (rolling 30s)   │
└─────────────────┘           └─────────┬────────┘
                                         │ signal
                                         ▼
                              ┌──────────────────────────┐
                              │  Express + x402 middleware│
                              │  /signals/latest — $0.003 │◀──── pay ──┐
                              └──────────┬───────────────┘             │
                                         │                              │
                                         ▼                              │
                              ┌──────────────────────────┐    ┌────────┴────────┐
                              │  Circle Gateway Facilitator│   │ Consumer CLI    │
                              │  verify + off-chain batch │    │ (AlphaDrip sub) │
                              └──────────┬───────────────┘    └─────────────────┘
                                         │
                                         ▼ (periodic)
                              ┌──────────────────────────┐
                              │  ARC L1 testnet          │
                              │  batched USDC settlement │
                              └──────────────────────────┘
```

**Key choices:**

- Each **paid API call** = one x402-authorized `EIP-3009` signature (off-chain, gas-free)
- Circle Gateway batches signatures into a single on-chain settlement every ~30s
- The emitter never touches private keys — judges can verify the seller address is an EOA
- The cascade engine uses **free public HL data** (no paid APIs, no API keys)

---

## Live demo

- **Dashboard:** https://alphadrip.YOUR_DOMAIN.com (Bloomberg-terminal UI, live signals + settlements)
- **Endpoint:** `GET https://alphadrip.YOUR_DOMAIN.com/signals/latest` → 402 if unpaid
- **Video:** `docs/demo.mp4` (3 min)

Try it yourself in 30 seconds:

```bash
git clone https://github.com/Makabeez/alphadrip
cd alphadrip/consumer
npm install
echo "PRIVATE_KEY=0xYOUR_TESTNET_KEY" > .env
echo "EMITTER_URL=https://alphadrip.YOUR_DOMAIN.com" >> .env
npm run deposit    # one-time: deposits 1 USDC to Gateway
npm run subscribe  # streams paid signals for $0.50 budget
```

You should see BTC cascade signals tick in with a paid-per-call line for each:

```
► LONG_LIQ $94,281 │ vol 3.2× │ bias 84% │ conv 76 │ tp 94,000 │ paid $0.003
► LONG_LIQ $94,105 │ vol 4.1× │ bias 91% │ conv 88 │ tp 93,823 │ paid $0.003
► SHORT_LIQ $94,450 │ vol 2.8× │ bias 72% │ conv 62 │ tp 94,733 │ paid $0.003
```

---

## The cascade engine

HL doesn't publish a public liquidation WebSocket. But when their liquidation engine dumps positions, the aggressive market orders leave a fingerprint on the public trades feed:

- **Elevated volume** (>2.5× the 5-min baseline)
- **Directional bias** (>70% one-sided)
- **Tight clustering** in a 30-second window

When all three fire, we emit a signal with a `conviction` score and speculative take-profit/stop levels.

This is not a toy. It's a free, real-time, liquidation-proxy signal that would cost $500/month from Hypedexer or similar. We serve it at **$0.003/call** with on-chain payment receipts.

---

## Why this needs Circle + Arc (the margin argument)

| Chain | Gas / tx | AlphaDrip margin at $0.003/call |
|---|---|---|
| Ethereum mainnet | ~$0.50 | **−16,566%** (impossible) |
| Base | ~$0.01 | **−233%** (losing money) |
| Polygon | ~$0.002 | +33% (barely breakeven) |
| **Arc + Circle Gateway (batched)** | **~$0 per call** | **+99.9%** (viable) |

Gateway's off-chain EIP-3009 batching is the **only** settlement model where sub-cent signal distribution makes economic sense. This is not a performance optimization — it's an **enabling primitive** for a business model that couldn't exist before.

---

## What's next (v2)

- **Reputation receipts:** 10 min after each signal, log PnL outcome on-chain. Emitters build an immutable track record. Consumers discover good emitters through on-chain reputation instead of influencer hype.
- **Multi-emitter marketplace:** Anyone publishes a feed; AlphaDrip is the x402-compatible router.
- **Conditional pricing:** High-conviction signals cost $0.01; low-conviction, $0.001. Price is programmable because payments are programmable.

---

## Repo layout

```
alphadrip/
├── emitter/          # Node.js server with x402 middleware + live dashboard
│   ├── server.ts
│   ├── cascade-engine.ts
│   └── public/index.html
├── consumer/         # Subscriber CLI (pay, log, display)
│   ├── subscribe.ts
│   ├── deposit.ts
│   └── balance.ts
├── docs/
│   ├── architecture.svg
│   └── demo.mp4
└── README.md
```

---

## Credits

Built by [@makabeez](https://github.com/Makabeez) for the Agentic Economy on Arc hackathon, April 2026.

- **Circle Nanopayments** for off-chain EIP-3009 batching — the payment rail
- **Arc L1** for sub-second USDC settlement — the coordination layer
- **Hyperliquid** for free public market data
- **x402 protocol** for HTTP-native, account-less agent payments

MIT licensed. PRs welcome.
