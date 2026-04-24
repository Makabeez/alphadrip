/**
 * Balance checker — reads USDC balance on Arc Testnet for the consumer wallet.
 */

import {
  createPublicClient,
  defineChain,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

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

const pk = process.env.PRIVATE_KEY as Hex;
if (!pk) {
  console.error("❌ PRIVATE_KEY env var required");
  process.exit(1);
}

const account = privateKeyToAccount(pk);
const client = createPublicClient({ chain: arcTestnet, transport: http() });

const bal = await client.readContract({
  address: USDC_ADDRESS,
  abi: USDC_ABI,
  functionName: "balanceOf",
  args: [account.address],
});

const balUsdc = Number(bal) / 1_000_000;

console.log(`
  ┌──────────────────────────────────────────────────┐
  │  address:  ${account.address}  │
  │  USDC:     ${balUsdc.toFixed(6).padStart(20)} on Arc Testnet │
  │  signals:  ~${Math.floor(balUsdc / 0.003).toString().padStart(6)} @ $0.003 each              │
  └──────────────────────────────────────────────────┘
`);