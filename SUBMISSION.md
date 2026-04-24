```markdown

\# AlphaDrip - Agentic Economy on Arc Hackathon



\## Inspiration

Trading signals are the canonical case for sub-cent metered access. The marginal value of each individual signal is tiny ($0.003), but the aggregate volume is high. Conventional payment rails make per-call billing impossible due to minimum fees. We wanted to prove that Arc's sub-cent gas and high-speed execution could make a true "pay-per-alpha" model economically viable.



\## What it does

AlphaDrip detects BTC liquidation cascades on Hyperliquid in real time and exposes them through an x402-paywalled HTTP API. Consumers pay $0.003 USDC per request. The consumer signs an EIP-3009 `TransferWithAuthorization`, and the server relays it directly to the Arc Testnet. Once the sub-second transaction clears, the signal is delivered.



\## How we built it

We used a Node.js Express server to expose the x402 endpoint and a secondary process to listen to the Hyperliquid websocket. We integrated `viem` to handle the EIP-712 typed data signing and direct interaction with the USDC contract on Arc Testnet.



\## Challenges we ran into

\### Circle Product Feedback

We originally planned to use Circle Gateway's batched-x402 facilitator (`gateway-api.circle.com/v1/x402/settle`). However, we discovered it currently returns `errorReason: "unsupported\_network"` for Arc Testnet (`eip155:5042002`). We pivoted to implementing the EIP-3009 relayer directly on the emitter, proving the flexibility of the x402 standard even without a centralized facilitator.



\## Accomplishments that we're proud of

During a 326-second live test, the system successfully processed \*\*163 paid API calls\*\* seamlessly. We proved that an agentic economy can function at $0.003 per transaction while maintaining a 36% margin after gas costs (\~$0.0019 per tx).



\## What's next for AlphaDrip

\- Decentralized signal aggregation

\- Mainnet deployment on Arc

\- Additional trading pairs

