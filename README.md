\# AlphaDrip

> \*\*Pay-per-alpha. Sub-cent trading signals settled on Arc.\*\*

>

> An x402 monetized signal feed where every API call is a real on-chain USDC transfer on Arc Testnet. No subscriptions. No middlemen. $0.003 per signal, settled in real time, verifiable at \[testnet.arcscan.app](https://testnet.arcscan.app/address/0x9747B4B2F4EcB59C4055c45CDA0Ae0D44A04eD14).



\*\*Live demo:\*\* https://alphadrip.baserep.xyz

\*\*Submission for:\*\* lablab.ai · Agentic Economy on Arc Hackathon (Apr 2026)

\*\*Track:\*\* Per-API Monetization Engine



\---



\## What it does

AlphaDrip detects BTC liquidation cascades on Hyperliquid in real time and exposes them through a paywalled HTTP API. Every request to `/signals/latest` returns HTTP 402 Payment Required. The client signs an EIP-3009 `TransferWithAuthorization` for $0.003 USDC. The server submits that authorization on-chain to Arc Testnet, waits for the transaction to confirm, and returns the most recent signal along with the Arc transaction hash.



This is the \[x402 protocol](https://www.x402.org) flow, implemented end-to-end without intermediaries: the consumer pays the producer directly through a real USDC transfer on Arc, with the producer acting as the EIP-3009 relayer.



A 326-second demo session produced \*\*163 paid API calls\*\*, \*\*263 cascade signals fired\*\*, and \*\*$0.483 USDC settled on-chain\*\*, all visible on the Arc Block Explorer:

→ https://testnet.arcscan.app/address/0x9747B4B2F4EcB59C4055c45CDA0Ae0D44A04eD14



\---



\## Why Arc

The hackathon brief was clear: build "economically viable transactions, paid agents, and self-sustaining services" using Arc and USDC. Trading signals are the canonical case for sub-cent metered access — the marginal value of each individual signal is tiny ($0.003 covers it), but the aggregate volume is high, and the cost of conventional payment rails (Stripe minimums, exchange fees, monthly subscriptions) makes per-call billing impossible everywhere except a USDC L1 with sub-cent gas.



Arc settles each `transferWithAuthorization` in \*\*sub-second time for \~$0.0019 of native USDC gas\*\*. Net revenue per signal is $0.0011 after gas, a 36% margin even at this dust-tier price. On Ethereum L1 the same transfer would cost dollars in gas — economically impossible. On Arc, it's not just possible, it's profitable.



\---



\## Architecture



```text

┌────────────────────┐                 ┌─────────────────────────────────┐

│   Hyperliquid WS   │ trades ───────▶ │  Cascade Engine                 │

│  (BTC public feed) │                 │  · 30s rolling window           │

└────────────────────┘                 │  · vol >2.5x baseline           │

&#x20;                                      │  · directional bias >70%        │

&#x20;                                      └─────────────┬───────────────────┘

&#x20;                                                    │ signal

&#x20;                                                    ▼

GET /signals/latest                    ┌─────────────────────────────────┐

(no payment)                           │  Express + x402 paywall         │

───────────────────────────────────▶   │  · Returns 402 + payment-       │

&#x20;                                      │    required header              │

◀──────────────────────────────────    │  · accepts: eip155:5042002 USDC │

HTTP 402 + accepts                     └─────────────┬───────────────────┘

&#x20;                                                    │

Consumer signs EIP-3009                              │

TransferWithAuthorization                            │

($0.003 USDC, payTo seller)                          │

───────────────────────────────────▶                 ▼

payment-signature: <base64>            ┌─────────────────────────────────┐

&#x20;                                      │  EIP-3009 Relayer               │

&#x20;                                      │  · Decode v, r, s               │

&#x20;                                      │  · transferWithAuthorization()  │

&#x20;                                      │    on USDC @ 0x3600...          │

&#x20;                                      │  · Wait for receipt             │

&#x20;                                      └─────────────┬───────────────────┘

&#x20;                                                    │ tx hash

&#x20;                                                    ▼

&#x20;                                      Real USDC transfer on Arc Testnet

&#x20;                                      Block confirmed, \~0.0019 USDC gas

&#x20;                                                    │

◀────────────────────────────────── ◀─────────────┘

HTTP 200 + signal + tx\_hash

Componentsemitter/cascade-engine.ts — Connects to Hyperliquid public WS (wss://api.hyperliquid.xyz/ws), subscribes to BTC trades, evaluates 30s rolling windows against a 5min baseline, fires CascadeSignal events when volume spikes >2.5× with directional bias >70%.emitter/server.ts — Express server. On unpaid requests, returns 402 with custom accepts array advertising Arc Testnet. On paid requests, decodes the EIP-712 signature, calls transferWithAuthorization on the USDC contract via viem, waits for the receipt, returns the signal payload with the Arc tx hash.emitter/public/index.html — Bloomberg-terminal × cypherpunk dashboard. WebSocket-pushed live updates. Recent settlements panel with clickable tx links to arcscan.consumer/subscribe.ts — Polling client. On 402, signs EIP-712 typed data with the standard Circle FiatTokenV2 domain (name:"USDC", version:"2", chainId: 5042002), retries with payment-signature header.NetworkArc Testnet RPC: https://rpc.testnet.arc.networkChain ID: 5042002 (0x4cef52)USDC contract: 0x3600000000000000000000000000000000000000 (6 decimals, native EIP-3009)Explorer: https://testnet.arcscan.appWhy direct EIP-3009 instead of Circle's batched-x402 facilitatorThe original architecture targeted Circle Gateway's batched-x402 facilitator (gateway-api.circle.com/v1/x402/settle) for off-chain payment aggregation. That facilitator returns errorReason: "unsupported\_network" for eip155:5042002 (Arc Testnet) as of April 2026. See the Circle Product Feedback section in SUBMISSION.md for the full debug session.The Arc team's recommendation in the lablab.ai Discord was explicit:"You can build x402-style logic on Arc. It's not a built-in standard, so you'll need to implement the logic yourself."That's what AlphaDrip does. The x402 spec defines assetTransferMethod: "eip3009" for exactly this case — when an EIP-3009-compliant ERC20 like USDC is the payment asset, the facilitator's only job is to relay the signed authorization on-chain. We do that directly: no facilitator, no batching abstraction, just the same transferWithAuthorization primitive Circle Nanopayments is built on, called directly against Arc's USDC contract.The economic model is identical to what Nanopayments delivers; it just runs without the facilitator dependency that doesn't yet support Arc Testnet.Quick startRun the emitterBashcd emitter

cp .env.example .env



\# fill in SELLER\_WALLET\_ADDRESS and SELLER\_PRIVATE\_KEY

\# faucet a small amount of USDC to the seller wallet at faucet.circle.com (Arc Testnet)

npm install

npm run dev   # or: npx tsx server.ts

Dashboard: http://localhost:3005Run the consumerBashcd consumer

cp .env.example .env



\# fill in PRIVATE\_KEY (a separate EOA with USDC on Arc Testnet)

npm install

npm run balance       # confirm wallet has USDC

npm run subscribe     # start paying for signals

Each call costs $0.003 USDC. Default budget is $0.20 (\~66 signals).Demo session resultsRecorded session, 326 seconds:MetricValueCascade signals fired263Paid API calls (on-chain settlements)163Unique signals delivered19Total spent by consumer$0.483 USDCTotal earned by seller$0.489 USDCAverage gas per tx\~$0.0019 USDCAverage price per unique signal$0.0254Block range38818754 → 38819231All 163 transactions: https://testnet.arcscan.app/address/0x9747B4B2F4EcB59C4055c45CDA0Ae0D44A04eD14StackRuntime: Node 22, TypeScript, tsxServer: Express, ws (WebSocket)Chain: viem (no wagmi, no ethers — just the wallet client and EIP-712 signer)Data: Hyperliquid public WebSocket trade tapeHosting: DigitalOcean droplet (Frankfurt) under PM2, Cloudflare Tunnel for public accessDependencies removed: @circle-fin/x402-batching (replaced by direct EIP-3009 settlement)Repo layoutPlaintextalphadrip/

├── emitter/

│   ├── server.ts             # Express + x402 + EIP-3009 relayer

│   ├── cascade-engine.ts     # HL trade-tape → CascadeSignal events

│   ├── public/index.html     # Dashboard (Bloomberg-terminal aesthetic)

│   ├── ecosystem.config.cjs  # PM2 config

│   └── package.json

├── consumer/

│   ├── subscribe.ts          # Polling client, signs EIP-3009, retries with header

│   ├── balance.ts            # Arc USDC balance check

│   └── package.json

├── docs/

│   └── architecture.svg

├── README.md                 # This file

├── SUBMISSION.md             # Devpost-format submission writeup

└── QUICKSTART.md             # 5-minute local-run guide

Submission linksLive dashboard: https://alphadrip.baserep.xyzGitHub: https://github.com/Makabeez/alphadripArc explorer (seller wallet): https://testnet.arcscan.app/address/0x9747B4B2F4EcB59C4055c45CDA0Ae0D44A04eD14Devpost submission: see SUBMISSION.mdLicenseMIT.

