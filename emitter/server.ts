/**
 * AlphaDrip Emitter Server — Direct x402 on Arc Testnet
 *
 * Implements the x402 payment loop end-to-end without relying on Circle
 * Gateway's batched-x402 facilitator (which does not currently support Arc
 * Testnet — the facilitator returns "unsupported_network" for chain id
 * 5042002 as of April 2026).
 *
 * Following the explicit guidance from the Arc team in Discord:
 *   "You can build x402-style logic on Arc. It's not a built-in standard,
 *    so you'll need to implement the logic yourself."
 *
 * Each paid signal triggers a REAL on-chain USDC transfer via the native
 * `transferWithAuthorization` (EIP-3009) function on Arc's USDC contract at
 * 0x3600000000000000000000000000000000000000. Every paid call is verifiable
 * on https://testnet.arcscan.app — satisfying the hackathon requirement
 * that transactions settle on the Arc Block Explorer.
 */

import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CascadeEngine, CascadeSignal } from "./cascade-engine.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ═══════════════════════════════════════════════════════════════
// Arc Testnet chain definition
// ═══════════════════════════════════════════════════════════════

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.arc.network"] },
  },
  blockExplorers: {
    default: { name: "ArcScan", url: "https://testnet.arcscan.app" },
  },
});

// ═══════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════

const PORT = parseInt(process.env.PORT || "3000", 10);
const SELLER_ADDRESS = (process.env.SELLER_WALLET_ADDRESS || "") as Address;
const SELLER_PRIVATE_KEY = (process.env.SELLER_PRIVATE_KEY || "") as Hex;
const PRICE_USDC = "0.003";
const PRICE_BASE_UNITS = 3000n; // 6-decimal USDC base units for $0.003

const USDC_ADDRESS = "0x3600000000000000000000000000000000000000" as Address;

if (!SELLER_ADDRESS || !SELLER_PRIVATE_KEY) {
  console.error(
    "❌ SELLER_WALLET_ADDRESS and SELLER_PRIVATE_KEY env vars required"
  );
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════
// Viem clients — the emitter acts as relayer, paying gas in USDC
// ═══════════════════════════════════════════════════════════════

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(),
});

const sellerAccount = privateKeyToAccount(SELLER_PRIVATE_KEY);
const walletClient = createWalletClient({
  account: sellerAccount,
  chain: arcTestnet,
  transport: http(),
});

// EIP-3009 transferWithAuthorization ABI
const USDC_ABI = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external",
  "function authorizationState(address authorizer, bytes32 nonce) external view returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
]);

// ═══════════════════════════════════════════════════════════════
// x402 payment advertisement (our own, Arc-native)
// ═══════════════════════════════════════════════════════════════

const ARC_PAYMENT_OPTION = {
  scheme: "exact",
  network: "eip155:5042002",
  asset: USDC_ADDRESS,
  amount: PRICE_BASE_UNITS.toString(),
  payTo: SELLER_ADDRESS,
  maxTimeoutSeconds: 345600, // 4 days
  extra: {
    // Standard Circle FiatTokenV2 EIP-712 domain (verified on-chain)
    name: "USDC",
    version: "2",
    verifyingContract: USDC_ADDRESS,
    assetTransferMethod: "eip3009",
  },
};

// ═══════════════════════════════════════════════════════════════
// App & state
// ═══════════════════════════════════════════════════════════════

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/live" });
const engine = new CascadeEngine();

const stats = {
  signals_fired: 0,
  signals_paid_for: 0,
  total_earned_usdc: 0,
  unique_payers: new Set<string>(),
  recent_settlements: [] as {
    payer: string;
    amount: number;
    tx_hash: string;
    time: number;
  }[],
  recent_signals: [] as CascadeSignal[],
};

app.use(express.static(join(__dirname, "public")));

app.get("/metadata", (_req, res) => {
  res.json({
    service: "AlphaDrip Cascade Feed",
    price_per_signal: "$" + PRICE_USDC,
    settlement_chain: "Arc Testnet (eip155:5042002)",
    usdc_contract: USDC_ADDRESS,
    explorer: "https://testnet.arcscan.app",
    stats: {
      signals_fired: stats.signals_fired,
      signals_paid_for: stats.signals_paid_for,
      unique_payers: stats.unique_payers.size,
      total_earned_usdc: stats.total_earned_usdc.toFixed(6),
    },
  });
});

// ═══════════════════════════════════════════════════════════════
// THE MONEY ENDPOINT
// ═══════════════════════════════════════════════════════════════

app.get("/signals/latest", async (req, res) => {
  try {
    const paymentHeader = req.headers["payment-signature"] as
      | string
      | undefined;

    // ── Unpaid request: return 402 with Arc payment requirements ──
    if (!paymentHeader) {
      const paymentRequired = {
        x402Version: 2,
        resource: {
          url: req.url ?? "/signals/latest",
          description: "AlphaDrip cascade signal",
          mimeType: "application/json",
        },
        accepts: [ARC_PAYMENT_OPTION],
      };
      const headerValue = Buffer.from(
        JSON.stringify(paymentRequired)
      ).toString("base64");
      res.statusCode = 402;
      res.setHeader("PAYMENT-REQUIRED", headerValue);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({}));
      return;
    }

    // ── Decode the payment payload ────────────────────────────────
    const paymentPayload = JSON.parse(
      Buffer.from(paymentHeader, "base64").toString("utf-8")
    );

    const acceptedNetwork = paymentPayload?.accepted?.network;
    if (acceptedNetwork !== "eip155:5042002") {
      res.status(400).json({
        error: "Only Arc Testnet (eip155:5042002) accepted",
        received: acceptedNetwork,
      });
      return;
    }

    const auth = paymentPayload?.payload?.authorization;
    const signatureHex: Hex = paymentPayload?.payload?.signature;
    if (!auth || !signatureHex) {
      res.status(400).json({ error: "Missing authorization or signature" });
      return;
    }

    // Validate the authorization is what we expect
    if (
      (auth.to as string).toLowerCase() !== SELLER_ADDRESS.toLowerCase() ||
      BigInt(auth.value) !== PRICE_BASE_UNITS
    ) {
      res.status(400).json({
        error: "Authorization mismatch",
        expected: { to: SELLER_ADDRESS, value: PRICE_BASE_UNITS.toString() },
        received: { to: auth.to, value: auth.value },
      });
      return;
    }

    // Decode signature into v, r, s
    const sigNoPrefix = signatureHex.slice(2);
    const r = ("0x" + sigNoPrefix.slice(0, 64)) as Hex;
    const s = ("0x" + sigNoPrefix.slice(64, 128)) as Hex;
    const v = parseInt(sigNoPrefix.slice(128, 130), 16);

    console.log(
      `\n[pay] ── incoming payment from ${auth.from.slice(0, 10)}... ──`
    );
    console.log(
      `[pay] amount=${auth.value} nonce=${auth.nonce.slice(0, 10)}... v=${v}`
    );

    // ── Submit the authorization on-chain ─────────────────────────
    let txHash: Hex;
    try {
      txHash = await walletClient.writeContract({
        address: USDC_ADDRESS,
        abi: USDC_ABI,
        functionName: "transferWithAuthorization",
        args: [
          auth.from as Address,
          auth.to as Address,
          BigInt(auth.value),
          BigInt(auth.validAfter),
          BigInt(auth.validBefore),
          auth.nonce as Hex,
          v,
          r,
          s,
        ],
      });
      console.log(`[pay] tx submitted: ${txHash}`);
    } catch (e: any) {
      console.error(
        `[pay] ✗ transferWithAuthorization failed: ${e.shortMessage ?? e.message}`
      );
      res.status(402).json({
        error: "On-chain settlement failed",
        reason: e.shortMessage ?? e.message,
      });
      return;
    }

    // Wait for inclusion — Arc is sub-second, so this is fast
    let receipt;
    try {
      receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 15_000,
      });
    } catch (e: any) {
      console.error(`[pay] receipt wait failed: ${e.message}`);
      receipt = { status: "unknown" as any };
    }

    if (receipt.status !== "success") {
      console.error(`[pay] ✗ tx reverted: ${txHash}`);
      res.status(402).json({
        error: "Transaction reverted",
        tx_hash: txHash,
      });
      return;
    }

    // ── Success — record and return signal ────────────────────────
    const payer = auth.from;
    const amountUsdc = Number(PRICE_BASE_UNITS) / 1_000_000;

    stats.signals_paid_for += 1;
    stats.total_earned_usdc += amountUsdc;
    stats.unique_payers.add(payer);
    stats.recent_settlements.unshift({
      payer,
      amount: amountUsdc,
      tx_hash: txHash,
      time: Date.now(),
    });
    if (stats.recent_settlements.length > 20) stats.recent_settlements.pop();

    console.log(
      `[pay] ✅ ${payer.slice(0, 10)}... paid ${amountUsdc} USDC | tx=${txHash.slice(0, 16)}...`
    );

    broadcast({
      type: "payment",
      payer,
      amount: amountUsdc,
      tx_hash: txHash,
      explorer_url: `https://testnet.arcscan.app/tx/${txHash}`,
      time: Date.now(),
    });

    const signal = engine.getLatest();
    res.json({
      ok: true,
      signal,
      paid_by: payer,
      settlement: {
        network: "eip155:5042002",
        tx_hash: txHash,
        explorer_url: `https://testnet.arcscan.app/tx/${txHash}`,
      },
    });
  } catch (e: any) {
    console.error("[pay] unhandled error:", e);
    res.status(500).json({ error: e?.message ?? "internal error" });
  }
});

// ═══════════════════════════════════════════════════════════════
// WebSocket push
// ═══════════════════════════════════════════════════════════════

function broadcast(msg: object) {
  const payload = JSON.stringify(msg);
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(payload);
  });
}

wss.on("connection", (ws) => {
  ws.send(
    JSON.stringify({
      type: "snapshot",
      stats: {
        signals_fired: stats.signals_fired,
        signals_paid_for: stats.signals_paid_for,
        total_earned_usdc: stats.total_earned_usdc,
        unique_payers: stats.unique_payers.size,
      },
      recent_signals: stats.recent_signals.slice(0, 10),
      recent_settlements: stats.recent_settlements.slice(0, 10),
      seller: SELLER_ADDRESS,
      price: "$" + PRICE_USDC,
      chain: "Arc Testnet",
      explorer: "https://testnet.arcscan.app",
    })
  );
});

engine.on("signal", (signal: CascadeSignal) => {
  stats.signals_fired += 1;
  stats.recent_signals.unshift(signal);
  if (stats.recent_signals.length > 50) stats.recent_signals.pop();
  broadcast({ type: "signal", signal });
});

engine.start();

// ═══════════════════════════════════════════════════════════════
// Startup sanity check
// ═══════════════════════════════════════════════════════════════

(async () => {
  try {
    const bal = await publicClient.readContract({
      address: USDC_ADDRESS,
      abi: USDC_ABI,
      functionName: "balanceOf",
      args: [SELLER_ADDRESS],
    });
    const balUsdc = Number(bal) / 1_000_000;
    console.log(
      `[init] seller USDC balance: ${balUsdc} USDC (for gas + receiving payments)`
    );
    if (balUsdc < 0.1) {
      console.warn(
        `[init] ⚠  seller balance low — faucet USDC to ${SELLER_ADDRESS} at https://faucet.circle.com (Arc Testnet)`
      );
    }
  } catch (e: any) {
    console.error(`[init] could not check seller balance: ${e.message}`);
  }
})();

httpServer.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  AlphaDrip Emitter — Arc-native x402                    ║
║  ──────────────────                                      ║
║  Dashboard:       http://localhost:${PORT}                   ║
║  Signal endpoint: http://localhost:${PORT}/signals/latest    ║
║  Price per call:  $${PRICE_USDC}                                 ║
║  Settlement:      transferWithAuthorization (EIP-3009)  ║
║  Chain:           Arc Testnet (5042002)                 ║
║  USDC contract:   ${USDC_ADDRESS}  ║
║  Seller:          ${SELLER_ADDRESS}  ║
╚══════════════════════════════════════════════════════════╝
`);
});