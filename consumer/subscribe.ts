/**
 * AlphaDrip Subscriber — direct EIP-3009 on Arc Testnet
 *
 * Polls the emitter every N seconds. For each poll:
 *   1. Request resource → get 402 with payment requirements
 *   2. Sign EIP-3009 TransferWithAuthorization message (off-chain)
 *   3. Retry request with PAYMENT-SIGNATURE header
 *   4. Emitter relays the authorization on-chain via transferWithAuthorization
 *   5. Receive signal + real Arc tx hash, log to signals.jsonl
 *
 * No Circle SDK, no Gateway deposit. Consumer pays directly from wallet
 * each call. Each payment is a real on-chain USDC transfer, visible at
 * https://testnet.arcscan.app/address/<consumer>
 */

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  hexToNumber,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

// ═══════════════════════════════════════════════════════════════
// Chain + constants
// ═══════════════════════════════════════════════════════════════

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
});

const USDC_ADDRESS = "0x3600000000000000000000000000000000000000" as Address;
const USDC_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

const PK = process.env.PRIVATE_KEY as Hex;
const URL = process.env.EMITTER_URL || "http://localhost:3005";
const BUDGET = parseFloat(process.env.BUDGET_USDC || "0.2");
const POLL_INTERVAL_MS = parseInt(process.env.POLL_MS || "3000", 10);

if (!PK) {
  console.error("❌ PRIVATE_KEY env var required");
  process.exit(1);
}

const account = privateKeyToAccount(PK);
const walletClient = createWalletClient({
  account,
  chain: arcTestnet,
  transport: http(),
});
const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(),
});

const endpoint = `${URL}/signals/latest`;

// ═══════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════

let spent = 0;
let calls = 0;
let signalsReceived = 0;
const seenSignals = new Set<string>();
const startTime = Date.now();

// ═══════════════════════════════════════════════════════════════
// UI
// ═══════════════════════════════════════════════════════════════

const C = {
  dim: "\x1b[90m",
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
  magenta: "\x1b[35m",
};

function banner() {
  console.log(`
${C.green}${C.bold}  ╔════════════════════════════════════════════════╗
  ║  ALPHADRIP SUBSCRIBER — direct EIP-3009 on Arc ║
  ║  ─────────────────                             ║
  ║  emitter:  ${URL.padEnd(36)}║
  ║  payer:    ${account.address.slice(0, 14)}...${account.address.slice(-8)}       ║
  ║  budget:   $${BUDGET.toFixed(3)} USDC                          ║
  ║  poll:     every ${POLL_INTERVAL_MS}ms                        ║
  ╚════════════════════════════════════════════════╝${C.reset}
`);
}

function fmtTime() {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function status() {
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const remaining = BUDGET - spent;
  console.log(
    `${C.dim}[${fmtTime()}]${C.reset} ` +
      `calls=${C.cyan}${calls}${C.reset} ` +
      `signals=${C.green}${signalsReceived}${C.reset} ` +
      `spent=${C.yellow}$${spent.toFixed(6)}${C.reset} ` +
      `budget=${C.magenta}$${remaining.toFixed(6)}${C.reset} ` +
      `t=${elapsed}s`
  );
}

function finalSummary() {
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`
${C.bold}${C.cyan}  ── session summary ──${C.reset}
  duration:         ${elapsed}s
  paid calls:       ${calls}
  unique signals:   ${signalsReceived}
  total spent:      $${spent.toFixed(6)}
  avg $/signal:     ${signalsReceived > 0 ? "$" + (spent / signalsReceived).toFixed(6) : "—"}
  log:              signals.jsonl
  verify on-chain:  https://testnet.arcscan.app/address/${account.address}
`);
}

// ═══════════════════════════════════════════════════════════════
// x402 flow: get 402 → sign → retry with PAYMENT-SIGNATURE
// ═══════════════════════════════════════════════════════════════

interface PaymentAccepts {
  scheme: string;
  network: string;
  asset: Address;
  amount: string;
  payTo: Address;
  maxTimeoutSeconds: number;
  extra: {
    name: string;
    version: string;
    verifyingContract: Address;
    assetTransferMethod?: string;
  };
}

async function fetchPaymentRequirements(): Promise<PaymentAccepts | null> {
  const res = await fetch(endpoint);
  if (res.status !== 402) return null;
  const header = res.headers.get("payment-required");
  if (!header) return null;
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
  const arcOption = (decoded.accepts as PaymentAccepts[]).find(
    (a) => a.network === "eip155:5042002"
  );
  return arcOption ?? null;
}

async function signAndPay(req: PaymentAccepts): Promise<Response> {
  // Build the EIP-3009 authorization
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address,
    to: req.payTo,
    value: BigInt(req.amount),
    validAfter: BigInt(now - 60), // 60s ago (clock skew tolerance)
    validBefore: BigInt(now + req.maxTimeoutSeconds),
    nonce: ("0x" + randomBytes(32).toString("hex")) as Hex,
  };

  // Sign EIP-712 typed data — this is the off-chain authorization
  const signature = await walletClient.signTypedData({
    domain: {
      name: req.extra.name,
      version: req.extra.version,
      chainId: 5042002,
      verifyingContract: req.extra.verifyingContract,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: authorization,
  });

  // Pack into the x402 PAYMENT-SIGNATURE header format (v2)
  const paymentPayload = {
    x402Version: 2,
    payload: {
      authorization: {
        from: authorization.from,
        to: authorization.to,
        value: authorization.value.toString(),
        validAfter: authorization.validAfter.toString(),
        validBefore: authorization.validBefore.toString(),
        nonce: authorization.nonce,
      },
      signature,
    },
    resource: {
      url: "/signals/latest",
      description: "AlphaDrip cascade signal",
      mimeType: "application/json",
    },
    accepted: {
      scheme: req.scheme,
      network: req.network,
      asset: req.asset,
      amount: req.amount,
      payTo: req.payTo,
      maxTimeoutSeconds: req.maxTimeoutSeconds,
      extra: req.extra,
    },
  };

  const headerValue = Buffer.from(JSON.stringify(paymentPayload)).toString(
    "base64"
  );

  return fetch(endpoint, {
    headers: { "payment-signature": headerValue },
  });
}

// ═══════════════════════════════════════════════════════════════
// Main loop
// ═══════════════════════════════════════════════════════════════

async function tick() {
  if (spent >= BUDGET) {
    console.log(`${C.yellow}⏹  budget exhausted — stopping${C.reset}`);
    finalSummary();
    process.exit(0);
  }

  try {
    calls += 1;

    // Step 1: fetch payment requirements
    const req = await fetchPaymentRequirements();
    if (!req) {
      console.log(
        `${C.red}  ✗ could not get Arc Testnet payment option from 402${C.reset}`
      );
      return;
    }

    // Step 2: sign + retry
    const response = await signAndPay(req);

    if (response.status !== 200) {
      const errText = await response.text();
      console.log(
        `${C.red}  ✗ status ${response.status}: ${errText.slice(0, 150)}${C.reset}`
      );
      return;
    }

    const data: any = await response.json();
    const amountPaid = Number(req.amount) / 1_000_000;
    spent += amountPaid;

    if (!data.signal) {
      // Paid but engine has no signal yet — the payment went through though
      console.log(
        `${C.dim}  · paid $${amountPaid.toFixed(6)} (no fresh signal) tx=${data.settlement?.tx_hash?.slice(0, 12) ?? "?"}...${C.reset}`
      );
      return;
    }

    const sig = data.signal;
    if (seenSignals.has(sig.id)) return; // already seen
    seenSignals.add(sig.id);
    signalsReceived += 1;

    const sideColor = sig.side === "LONG_LIQ" ? C.red : C.green;
    const tx = data.settlement?.tx_hash as string | undefined;
    console.log(
      `${C.bold}${sideColor}► ${sig.side}${C.reset} ` +
        `${C.bold}$${Math.round(sig.price).toLocaleString()}${C.reset} ` +
        `${C.dim}│${C.reset} vol ${C.yellow}${sig.volume_ratio}×${C.reset} ` +
        `${C.dim}│${C.reset} bias ${C.yellow}${(sig.directional_bias * 100).toFixed(0)}%${C.reset} ` +
        `${C.dim}│${C.reset} conv ${C.cyan}${(sig.conviction * 100).toFixed(0)}${C.reset} ` +
        `${C.dim}│${C.reset} paid ${C.green}$${amountPaid.toFixed(3)}${C.reset} ` +
        (tx ? `${C.dim}│${C.reset} tx ${C.cyan}${tx.slice(0, 12)}...${C.reset}` : "")
    );

    appendFileSync(
      "signals.jsonl",
      JSON.stringify({
        received_at: Date.now(),
        tx_hash: tx,
        explorer_url: data.settlement?.explorer_url,
        ...sig,
      }) + "\n"
    );
  } catch (e: any) {
    console.log(`${C.red}  ✗ error: ${e.message}${C.reset}`);
  }
}

process.on("SIGINT", () => {
  console.log(`\n${C.yellow}⏹  stopped by user${C.reset}`);
  finalSummary();
  process.exit(0);
});

// ═══════════════════════════════════════════════════════════════
// Startup checks
// ═══════════════════════════════════════════════════════════════

banner();

(async () => {
  // Reachability check
  try {
    const r = await fetch(endpoint);
    if (r.status !== 402 && r.status !== 200) {
      console.error(
        `${C.red}❌ emitter returned unexpected status ${r.status}${C.reset}`
      );
      process.exit(1);
    }
    console.log(
      `${C.green}✓${C.reset} emitter reachable (HTTP ${r.status})`
    );
  } catch (e: any) {
    console.error(
      `${C.red}❌ cannot reach emitter: ${e.message}${C.reset}`
    );
    process.exit(1);
  }

  // Balance check
  try {
    const bal = await publicClient.readContract({
      address: USDC_ADDRESS,
      abi: USDC_ABI,
      functionName: "balanceOf",
      args: [account.address],
    });
    const balUsdc = Number(bal) / 1_000_000;
    console.log(
      `${C.green}✓${C.reset} wallet USDC on Arc: ${balUsdc.toFixed(6)} (~${Math.floor(balUsdc / 0.003)} signals)`
    );
    if (balUsdc < BUDGET) {
      console.error(
        `${C.red}⚠  balance $${balUsdc.toFixed(6)} < budget $${BUDGET} — faucet more at faucet.circle.com${C.reset}`
      );
      process.exit(1);
    }
  } catch (e: any) {
    console.error(`${C.red}⚠  balance check failed: ${e.message}${C.reset}`);
  }
  console.log("");

  setInterval(status, 15_000);
  setInterval(tick, POLL_INTERVAL_MS);
  tick();
})();