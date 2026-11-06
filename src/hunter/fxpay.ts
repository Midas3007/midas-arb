// Pay for one FX API call with x402, from the bot wallet (HUNTER_PRIVATE_KEY):
//   npm run fx-pay -- https://midas-fx-api.onrender.com/fx/NGN?size=1000            USDC on Base
//   npm run fx-pay -- https://midas-fx-api.onrender.com/fx/NGN?size=1000 --celo     USDT on Celo
//   npm run fx-pay -- https://midas-fx-api.onrender.com/fx/NGN?size=1000 --celo --usdc   USDC on Celo
// A real paid call through a facilitator is what gets the endpoint catalogued (the payment carries the endpoint's
// description), and a Celo payment is a Celo mainnet transaction anyone can verify. No gas is needed: the facilitator
// sends the transaction. The wallet only needs the $0.01 in the coin it pays with.
import 'dotenv/config'
import { toHex, type Address } from 'viem'
import { hunterAccount } from './clients.js'

const args = process.argv.slice(2)
const url = args.find((a) => a.startsWith('http'))
if (!url) { console.log('usage: npm run fx-pay -- <url of a paid endpoint> [--celo [--usdc]]'); process.exit(1) }
if (!process.env.HUNTER_PRIVATE_KEY) { console.log('needs HUNTER_PRIVATE_KEY (the wallet that pays)'); process.exit(1) }
const wantNetwork = args.includes('--celo') ? 'eip155:42220' : 'eip155:8453'
const wantSymbol = args.includes('--usdc') ? 'USDC' : args.includes('--celo') ? 'Tether USD' : 'USD Coin'
const acct = hunterAccount()
const first = await fetch(url)
if (first.status !== 402) { console.log(`expected 402, got ${first.status}: ${(await first.text()).slice(0, 200)}`); process.exit(1) }
const pr = JSON.parse(Buffer.from(first.headers.get('payment-required') ?? '', 'base64').toString() || '{}')
if (pr.x402Version !== 2) { console.log('no x402 v2 challenge (PAYMENT-REQUIRED header) in the 402'); process.exit(1) }
const req = (pr.accepts ?? []).find((r: any) => r.scheme === 'exact' && r.network === wantNetwork && r.extra?.name === wantSymbol)
if (!req) {
  console.log(`this endpoint does not take that payment now. It accepts: ${(pr.accepts ?? []).map((r: any) => `${r.extra?.name} on ${r.network}`).join(', ')}`)
  if (wantNetwork === 'eip155:42220') console.log('(Celo payments switch on when the server has X402_CELO_API_KEY.)')
  process.exit(1)
}
const chainId = Number(String(req.network).split(':')[1])
console.log(`price: $${Number(req.amount) / 1e6} in ${req.extra.name} on ${chainId === 42220 ? 'Celo' : 'Base'}, to ${req.payTo}`)
const now = Math.floor(Date.now() / 1000)
const authorization = { from: acct.address, to: req.payTo as Address, value: req.amount, validAfter: String(now - 60), validBefore: String(now + Math.min(300, req.maxTimeoutSeconds ?? 120)), nonce: toHex(crypto.getRandomValues(new Uint8Array(32))) }
const signature = await acct.signTypedData({
  domain: { name: req.extra.name, version: req.extra.version, chainId, verifyingContract: req.asset },
  types: { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] },
  primaryType: 'TransferWithAuthorization',
  message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) } as any,
})
// The extensions are echoed back: that is what lets the facilitator catalogue the endpoint (Bazaar).
const payment = { x402Version: 2, resource: pr.resource, accepted: req, payload: { signature, authorization }, extensions: pr.extensions }
const paid = await fetch(url, { headers: { 'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(payment)).toString('base64') } })
const receipt = paid.headers.get('payment-response')
console.log(`status ${paid.status}${receipt ? `; receipt ${Buffer.from(receipt, 'base64').toString()}` : ''}`)
if (receipt) {
  const tx = JSON.parse(Buffer.from(receipt, 'base64').toString()).transaction
  if (tx) console.log(`see it: ${chainId === 42220 ? 'https://celoscan.io/tx/' : 'https://basescan.org/tx/'}${tx}`)
}
const body = await paid.text()
console.log(body.slice(0, 1500))
