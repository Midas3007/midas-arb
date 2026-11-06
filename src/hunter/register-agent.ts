// Register the FX API in Celo's ERC-8004 Identity Registry (0x8004A169…a432), from the bot wallet:
//   npm run register-agent -- https://midas-fx-api.onrender.com          shows what it would do and the gas cost
//   npm run register-agent -- https://midas-fx-api.onrender.com --go     sends it (needs a little CELO for gas)
// The registry is an ERC-721: the wallet receives an agent NFT whose URI points at the API's registration file
// (/.well-known/agent-registration.json). Then set ERC8004_AGENT_ID=<the id it prints> on Render, so the file lists
// the registration back (that two-way link is what verifies the domain).
import 'dotenv/config'
import { decodeEventLog, encodeFunctionData, formatEther, parseAbi, type Address } from 'viem'
import { CHAINS } from './chains.js'
import { clientsFor, sendTx } from './clients.js'
import { ERC8004_REGISTRY_CELO } from './fxapi.js'

const args = process.argv.slice(2)
const base = (args.find((a) => a.startsWith('http')) ?? process.env.PUBLIC_URL ?? '').replace(/\/$/, '')
if (!base) { console.log('usage: npm run register-agent -- https://your-api-address [--go]'); process.exit(1) }
if (!process.env.HUNTER_PRIVATE_KEY) { console.log('needs HUNTER_PRIVATE_KEY (the wallet that will own the agent)'); process.exit(1) }
const agentURI = `${base}/.well-known/agent-registration.json`
const abi = parseAbi([
  'function register(string agentURI) returns (uint256 agentId)',
  'function balanceOf(address owner) view returns (uint256)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
])
const reg = ERC8004_REGISTRY_CELO as Address

// 1. The registration file must be live before it is registered.
const file: any = await fetch(agentURI, { signal: AbortSignal.timeout(30_000) }).then((r) => r.json()).catch(() => null)
if (file?.type !== 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1') {
  console.log(`${agentURI} does not serve an ERC-8004 registration file yet: deploy the latest code to Render first.`); process.exit(1)
}
console.log(`registration file OK: "${file.name}", x402Support ${file.x402Support}`)

// 2. What it costs, and whether this wallet already owns an agent there.
const c = clientsFor(CHAINS.celo)
const owned = await c.pub.readContract({ address: reg, abi, functionName: 'balanceOf', args: [c.account.address] })
if (owned > 0n) console.log(`note: ${c.account.address} already owns ${owned} agent(s) in this registry`)
const data = encodeFunctionData({ abi, functionName: 'register', args: [agentURI] })
const [gas, price, bal] = await Promise.all([
  c.pub.estimateGas({ account: c.account.address, to: reg, data }),
  c.pub.getGasPrice(),
  c.pub.getBalance({ address: c.account.address }),
])
// The transaction is sent with a gas limit of 1.25x the estimate and a fee cap of about 2x the price, and the wallet
// must hold that maximum even though it pays about the estimate.
const need = (gas * 125n / 100n) * price * 2n
console.log(`register("${agentURI}") from ${c.account.address} on Celo: about ${formatEther(gas * price)} CELO of gas; the wallet must hold ${formatEther(need)} CELO (has ${formatEther(bal)})`)
if (bal < need) { console.log(`not enough CELO: send the bot wallet at least ${formatEther(need - bal)} more CELO on Celo (0.2 CELO is plenty, about 1-2 cents)`); process.exit(1) }
if (!args.includes('--go')) { console.log('add --go to send it'); process.exit(0) }

// 3. Send it and read the new agent id from the Registered event.
const rc = await sendTx(c, reg, data)
for (const l of rc.logs) {
  try {
    const e: any = decodeEventLog({ abi, data: l.data, topics: l.topics })
    if (e.eventName === 'Registered') {
      console.log(`registered: agent #${e.args.agentId} (tx https://celoscan.io/tx/${rc.transactionHash})`)
      console.log(`now set ERC8004_AGENT_ID=${e.args.agentId} on Render (Environment), so the file lists it back.`)
      process.exit(0)
    }
  } catch { /* other logs */ }
}
console.log(`sent (tx https://celoscan.io/tx/${rc.transactionHash}) but no Registered event was found; check it on Celoscan`)
