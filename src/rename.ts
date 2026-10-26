// Updates the ERC-8004 registration file for this agent (name, description, links). One tagged tx.
import { readFileSync } from 'node:fs'
import { encodeFunctionData, parseAbi } from 'viem'
import { verifyTx } from '@celo/attribution-tags'
import { account, pub, sendTagged } from './wallet.js'

const REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'
const abi = parseAbi([
  'function setAgentURI(uint256 agentId, string newURI)',
  'function ownerOf(uint256 tokenId) view returns (address)',
])
const agentId = BigInt(JSON.parse(readFileSync('agent.json', 'utf8')).agentId)

const owner = await pub.readContract({ address: REGISTRY, abi, functionName: 'ownerOf', args: [agentId] })
if (owner.toLowerCase() !== account.address.toLowerCase()) throw new Error(`Agent ${agentId} is owned by ${owner}, not this wallet`)

const file = {
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
  name: 'Kiyoshi',
  description:
    "Kiyoshi is an autonomous FX agent on Celo. It compares Textile FX RFQ quotes with Uniswap pools across Celo's local-currency corridors (wBRL, wARS, cNGN), trades the gaps when they beat costs, and publishes every trade and its P&L. Built by Mel Okoye (0xJedi) for Agents on Open Rails.",
  services: [
    { name: 'web', endpoint: 'https://github.com/MELcodes99/kiyoshi' },
    { name: 'status', endpoint: 'https://naira-desk.onrender.com/status' },
  ],
  x402Support: false,
  active: true,
  supportedTrust: ['reputation'],
  registrations: [{ agentId: Number(agentId), agentRegistry: `eip155:42220:${REGISTRY}` }],
}
const uri = 'data:application/json;base64,' + Buffer.from(JSON.stringify(file)).toString('base64')

const hash = await sendTagged({ to: REGISTRY, data: encodeFunctionData({ abi, functionName: 'setAgentURI', args: [agentId, uri] }) })
console.log(`Agent ${agentId} renamed to Kiyoshi   tx https://celoscan.io/tx/${hash}`)
const tag = await verifyTx({ client: pub, hash })
console.log('Tag check:', tag ? tag.codes.join(', ') : 'NOT FOUND')
