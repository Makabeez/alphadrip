# AlphaDrip — Devpost Submission

**Track:** Per-API Monetization Engine
**Hackathon:** lablab.ai · Agentic Economy on Arc (Apr 2026)
**Author:** [@Makabeez](https://github.com/Makabeez)

---

## Inspiration

Every active trader has paid \$200/month for a Telegram signal group that posted two trades. You paid for silence. The signal-aggregator market is the canonical case for **per-call metered pricing** — most signals are noise; you want to pay only for the ones you actually trigger on. Conventional payment rails make that impossible: Stripe minimums are \$0.50, exchange withdrawal fees are dollars, monthly subscriptions misalign incentives between producer and consumer.

Arc's economic profile (sub-cent gas, USDC as native unit of account, sub-second finality) is the first time per-call settlement at \$0.003 has been technically possible without batching. AlphaDrip is the simplest possible test of that thesis: a paywalled HTTP API that charges \$0.003 per request via real on-chain USDC transfers, with the producer earning a 36% margin after gas.

## What it does

AlphaDrip detects BTC liquidation cascades on Hyperliquid in real time and exposes them through a paywalled API endpoint. Every call to `GET /signals/latest` returns HTTP 402 Payment Required. The client signs an EIP-3009 `TransferWithAuthorization` for \$0.003 USDC. The server relays that authorization on-chain to Arc Testnet, waits for confirmation, and returns the latest cascade signal along with the Arc transaction hash.

The cascade engine connects to Hyperliquid's public WebSocket trade tape, evaluates a 30-second rolling volume window against a 5-minute baseline, and fires a `CascadeSignal` event when:

- Volume spikes >2.5× baseline
- Directional bias (buys vs sells) >70%
- Conviction score (volume × bias) crosses threshold

Each signal is a JSON payload: `{ side: "LONG_LIQ" | "SHORT_LIQ", price, volume_ratio, directional_bias, conviction, timestamp }`.

The dashboard at https://alphadrip.baserep.xyz shows live cascade events streaming in, recent paid settlements with clickable Arc tx links, and aggregate stats (signals fired, paid accesses, USDC earned, unique payers, avg \$/signal).

## How we built it

**Cascade engine** — TypeScript + ws, connects to `wss://api.hyperliquid.xyz/ws`, subscribes to BTC trades, maintains a rolling event buffer with timestamp eviction.

**x402 paywall** — Express middleware. On unpaid requests returns 402 with a base64-encoded `payment-required` header advertising Arc Testnet (`eip155:5042002`), USDC at `0x3600...`, payTo seller, amount `3000` (= \$0.003 in 6-decimal base units), `assetTransferMethod: "eip3009"`.

**EIP-3009 relayer** — On paid requests, decodes the consumer's `payment-signature` header, splits the signature into `v, r, s`, calls `transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s)` on the Arc USDC contract via [viem](https://viem.sh) `walletClient.writeContract`. Waits for receipt with `publicClient.waitForTransactionReceipt`, returns the signal payload along with the Arc tx hash and explorer URL.

**Consumer client** — Polls the emitter every 2 seconds. On 402, builds the EIP-712 typed data for the standard Circle FiatTokenV2 domain (`name: "USDC", version: "2", chainId: 5042002, verifyingContract: 0x3600...`), signs with `walletClient.signTypedData`, retries the request with the `payment-signature` header. Logs every received signal with its tx hash to `signals.jsonl`.

**Dashboard** — Vanilla HTML/JS, WebSocket-pushed live updates, Bloomberg-terminal aesthetic. Three panels: cascade signal feed, recent settlements with arcscan tx links, "how to subscribe" code snippet showing the actual EIP-3009 flow.

**Hosting** — DigitalOcean droplet (Frankfurt), Node 22 + tsx, PM2 for process management (`alphadrip-emitter` + `alphadrip-tunnel`), Cloudflare Tunnel terminating TLS at `alphadrip.baserep.xyz` and forwarding to localhost:3005.

## Demo session

A recorded 326-second session produced these numbers, all verifiable on-chain:

| Metric | Value |
|---|---|
| Cascade signals fired | 263 |
| Paid API calls (on-chain settlements) | 163 |
| Unique signals delivered | 19 |
| Total spent by consumer | \$0.483 USDC |
| Total earned by seller | \$0.489 USDC |
| Average gas per tx | ~\$0.0019 USDC |
| Block range | 38818754 → 38819231 |

All 163 paid transactions visible at: https://testnet.arcscan.app/address/0x9747B4B2F4EcB59C4055c45CDA0Ae0D44A04eD14

## Three mandatory hackathon answers

### 1. Sub-cent action pricing (≤\$0.01)

Per-call price: **\$0.003 USDC** (3000 in 6-decimal base units).

This is below 1¢, demonstrably economically viable on Arc, and consistent with the marginal value of an individual trading signal in a high-frequency feed.

### 2. 50+ on-chain transactions

**163 paid on-chain transactions in a single 326-second session.** All verifiable at the Arc Block Explorer link above. Each transaction is a real USDC transfer from the consumer wallet (`0x56d4...45be`) to the seller wallet (`0x9747...eD14`), settled via `transferWithAuthorization` on the Arc USDC contract.

### 3. Margin and viability without Arc

| Chain | USDC Transfer Gas | \$0.003 Price | Net Margin |
|---|---|---|---|
| Ethereum L1 | ~\$2.50 | \$0.003 | **−83,233%** (impossible) |
| Polygon PoS | ~\$0.05 | \$0.003 | −1,567% |
| Base | ~\$0.04 | \$0.003 | −1,233% |
| Arbitrum | ~\$0.02 | \$0.003 | −567% |
| **Arc** | **~\$0.0019** | **\$0.003** | **+36% margin** |

Arc is the only L1 that makes per-signal pricing at \$0.003 profitable. Anywhere else, gas exceeds revenue by orders of magnitude, and the only viable model is batching (which trades immediacy for cost). On Arc, immediacy and economics co-exist.

## Circle Product Feedback

The original architecture targeted **Circle Gateway's batched-x402 facilitator** (`https://gateway-api.circle.com/v1/x402/settle`) so that consumers could pay off-chain into Gateway and the producer would receive aggregated settlement. We hit a blocker:

**Bug report:** the Circle Gateway batched-x402 facilitator returns the following response for any settle attempt on Arc Testnet:

\`\`\`json
{
  "success": false,
  "errorReason": "unsupported_network",
  "transaction": "",
  "network": "eip155:5042002"
}
\`\`\`

The facilitator's `getSupported()` endpoint advertises 10 mainnet networks but does not include Arc Testnet (`eip155:5042002`), despite the Circle docs at `developers.circle.com` listing Arc Testnet as a Gateway-supported network for deposits and withdrawals. We confirmed deposits and balance reads on Arc Testnet **do** work via the Gateway API; only the **batched x402 settle path** is non-functional.

We reported this in the lablab.ai Discord and received explicit guidance from the Arc team:

> "You can build x402-style logic on Arc. It's not a built-in standard, so you'll need to implement the logic yourself."

We pivoted to direct EIP-3009 settlement against Arc's USDC contract at `0x3600...`. We verified on-chain that the contract is a standard Circle FiatTokenV2 (full EIP-3009 support: `TRANSFER_WITH_AUTHORIZATION_TYPEHASH = 0xd099cc98...`, `authorizationState()`, EIP-712 domain `{name: "USDC", version: "2"}`).

**Recommendation to Circle:** ship Arc Testnet support for the batched-x402 facilitator. The deposit and balance plumbing already works on Arc Testnet — only the settle path is missing. Once that's enabled, the `@circle-fin/x402-batching` SDK will work on Arc out of the box, no consumer-side code changes required.

We're submitting this feedback under the hackathon's **\$500 Product Feedback Incentive** — happy to provide repro logs, full payload dumps, and our discovery process notes for the Circle team.

## Challenges

1. **Circle Gateway batched-x402 facilitator doesn't support Arc Testnet.** Burned ~3 hours debugging before reading the JSON error response carefully and recognizing it as a server-side missing-network issue, not a client bug.
2. **Verifying Arc USDC supports EIP-3009.** Arc docs warn that `0x3600...` is a "system contract" and recommend using only the standard ERC-20 interface. We probed the contract directly (`name`, `version`, `DOMAIN_SEPARATOR`, `TRANSFER_WITH_AUTHORIZATION_TYPEHASH`, `authorizationState`) and confirmed it's a full Circle FiatTokenV2 with all EIP-3009 entry points.
3. **VPS UDP egress restrictions broke Cloudflare Tunnel's default QUIC protocol.** Switched the tunnel config to `protocol: http2` and the tunnel came up cleanly.
4. **PM2 ecosystem.config.cjs syntax.** Notepad's "save as" workflow occasionally introduced UTF-8 BOM bytes that broke the JS parser; switched to direct shell heredoc writes.

## Accomplishments

- **163 real on-chain USDC transfers on Arc Testnet in a single 5-minute session.** Each one verifiable on arcscan, each one a real `transferWithAuthorization` call against `0x3600...`.
- **End-to-end x402 implementation from scratch.** No Circle SDK dependency, no facilitator, just the wire-protocol behavior the spec describes.
- **Detailed product feedback for Circle on a real bug.** The "unsupported_network" finding is verifiable and actionable.
- **Working live demo at https://alphadrip.baserep.xyz** — judges can hit the URL, watch real cascade signals fire, see real settlements arrive with clickable Arc explorer links.

## What we learned

- The Arc USDC system contract is a real EIP-3009-compliant FiatTokenV2 — `transferWithAuthorization` works exactly as on every other Circle-issued USDC.
- The x402 spec is genuinely modular: when the asset transfer method is `eip3009`, no facilitator is strictly required for a producer-as-relayer architecture. The producer just needs gas (in USDC, on Arc, ~\$0.0019) to submit the signed authorization.
- Sub-cent gas changes the design space. Per-call billing without batching is now economically dominant for any high-volume, low-marginal-value digital good — signals, oracle reads, AI inference tokens, content unlocks. Arc is the first L1 where this works at \$0.003.

## What's next

- Move from polling to server-sent events on the consumer (lower latency, fewer redundant 402s for unchanged signals).
- Add a price discovery mechanism — let the producer dynamically price signals by conviction (\$0.001 for low-conviction, \$0.01 for high-conviction).
- Hyperliquid mainnet feed + multi-asset support (ETH, SOL, top perps).
- Integrate with Circle Gateway's batched-x402 facilitator once Arc Testnet support ships, so consumers can choose between immediate per-call settlement (current implementation) or aggregated off-chain settlement.

---

## Built with

`typescript` `viem` `express` `ws` `node` `pm2` `arc` `usdc` `eip-3009` `eip-712` `x402` `cloudflare-tunnel` `hyperliquid`

## Try it yourself

- **Live dashboard:** https://alphadrip.baserep.xyz
- **Source:** https://github.com/Makabeez/alphadrip
- **All on-chain settlements:** https://testnet.arcscan.app/address/0x9747B4B2F4EcB59C4055c45CDA0Ae0D44A04eD14

