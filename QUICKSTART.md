# QUICKSTART — Deploying AlphaDrip on the VPS

Deployment recipe for your Windows VPS (32 GB RAM, PM2 running).

---

## 0. Prerequisites (5 min)

You need:
- Node.js ≥ v18 (you have this)
- PM2 (already running your other processes)
- An EVM wallet — the **seller wallet** is where paid USDC will land. You can reuse the PropRail wallet or make a fresh one. Private key NOT needed on the emitter side — just the address.
- Testnet USDC from https://faucet.circle.com (Arc Testnet) for the **consumer** wallet

---

## 1. Get the code onto the VPS (2 min)

```powershell
# On the Windows VPS, wherever you keep projects:
cd C:\Hackathon
# Unzip the AlphaDrip folder here (or git clone once you push it)
cd alphadrip
```

You should see:
```
alphadrip/
├── emitter/
├── consumer/
├── docs/
└── README.md
```

---

## 2. Install dependencies (3 min)

```powershell
cd emitter
npm install
cd ..\consumer
npm install
cd ..
```

---

## 3. Configure the emitter (2 min)

```powershell
cd emitter
copy .env.example .env
notepad .env
```

Set:
```
SELLER_WALLET_ADDRESS=0xYOUR_EOA_HERE
PORT=3000
```

---

## 4. Launch the emitter under PM2 (2 min)

From `emitter/`:

```powershell
# Start under PM2 using tsx as the runner
pm2 start "npx tsx server.ts" --name alphadrip-emitter --cwd . --update-env

# Verify
pm2 logs alphadrip-emitter --lines 30
```

You should see:
```
╔══════════════════════════════════════════════════════════╗
║  AlphaDrip Emitter                                       ║
║  Dashboard:       http://localhost:3000                  ║
║  Signal endpoint: http://localhost:3000/signals/latest   ║
║  Price per call:  $0.003                                 ║
╚══════════════════════════════════════════════════════════╝
[engine] connecting to HL WebSocket...
[engine] HL WS connected, subscribing to BTC trades
```

Verify the paywall:

```powershell
curl -i http://localhost:3000/signals/latest
# should return HTTP/1.1 402 Payment Required + JSON accepts array
```

---

## 5. Expose publicly (5 min)

Judges need a public URL. Options:

### Option A — Existing nginx reverse proxy (preferred)
If you already have nginx fronting your droplet, add:
```nginx
location /alphadrip/ {
    proxy_pass http://127.0.0.1:3000/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```
Then visit `https://YOUR-DOMAIN/alphadrip/`.

### Option B — Cloudflare Tunnel (fastest)
```powershell
cloudflared tunnel --url http://localhost:3000
```
Gets you an instant `https://something-random.trycloudflare.com` URL. Perfect for the demo video.

---

## 6. Configure and run the consumer (3 min)

```powershell
cd ..\consumer
copy .env.example .env
notepad .env
```

Set:
```
PRIVATE_KEY=0xYOUR_TESTNET_PRIVATE_KEY    # consumer wallet, NOT the seller
EMITTER_URL=http://localhost:3000         # or your public URL
BUDGET_USDC=0.5
POLL_MS=2000
```

**Fund the consumer EOA** with:
- Testnet USDC from https://faucet.circle.com (Arc Testnet)
- A tiny bit of native gas from the Arc faucet (only needed for the one-time deposit)

Then:

```powershell
# One-time — deposits 1 USDC into Circle Gateway (one on-chain tx)
npm run deposit

# Runs the subscribe loop — pays $0.003 per signal
npm run subscribe
```

You should see paid signals streaming:
```
✓ emitter supports Gateway batched x402
✓ gateway balance: 1.000000 USDC

► LONG_LIQ $94,281 │ vol 3.2× │ bias 84% │ conv 76 │ tp 94,000 │ paid $0.003
► LONG_LIQ $94,105 │ vol 4.1× │ bias 91% │ conv 88 │ tp 93,823 │ paid $0.003
[12:42:30] calls=12 signals=2 spent=$0.036000 budget=$0.464000 t=24s
```

---

## 7. For the demo recording

Keep these three windows open side-by-side:
1. **Left**: Browser at your dashboard URL (`https://your-domain/`)
2. **Middle**: Terminal running `npm run subscribe`
3. **Right**: Browser at Arc testnet explorer showing your seller address — watch batch settlements land

Start subscribe during BTC volatility (US open, major news, etc.) for maximum signal fire rate.

---

## Troubleshooting

**"emitter does not support Gateway payments"**
- Check the emitter is actually running (`pm2 status alphadrip-emitter`)
- Check your `EMITTER_URL` matches

**"balance < budget"**
- Run `npm run balance` to check
- If 0, run `npm run deposit` first
- If deposit fails, faucet more USDC and make sure you have tiny gas on Arc

**Engine never fires signals**
- BTC is calm. Lower the thresholds in `cascade-engine.ts`:
  ```ts
  const VOL_THRESHOLD = 2.0;    // was 2.5
  const BIAS_THRESHOLD = 0.65;  // was 0.7
  ```
  Restart: `pm2 restart alphadrip-emitter`

**WebSocket disconnects**
- Engine auto-reconnects in 2s. If persistent, check that your VPS can reach `api.hyperliquid.xyz`.
