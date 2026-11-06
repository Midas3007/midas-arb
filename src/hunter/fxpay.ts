// Pay for one FX API call with x402, from the bot wallet (HUNTER_PRIVATE_KEY, USDC on Base):
//   npm run fx-pay -- https://your-api.onrender.com/fx/NGN?size=1000
// Use it once after deploying: a real paid call through the facilitator is what gets the endpoint listed in the
// x402 Bazaar (the payment carries the endpoint's description), and it proves settlement works end to end.
// Paying yourself works, but set X402_PAY_TO on the server to another address of yours to see the money move.
import 'dotenv/config'
import { toHex } from 'viem'
import { hunterAccount } from './clients.js'

const url = process.argv[2]
if (!url) { console.log('usage: npm run fx-pay -- <url of a paid endpoint>'); process.exit(1) }
if (!process.env.HUNTER_PRIVATE_KEY) { console.log('needs HUNTER_PRIVATE_KEY (the wallet that pays, with USDC on Base)'); process.exit(1) }
const acct = hunterAccount()
const first = await fetch(url)
if (first.status !== 402) { console.log(`expected 402, got ${first.status}: ${(await first.text()).slice(0, 200)}`); process.exit(1) }
const pr = JSON.parse(Buffer.from(first.headers.get('payment-required') ?? '', 'base64').toString() || '{}')
const req = pr.accepts?.[0]
if (pr.x402Version !== 2 || !req) { console.log('no x402 v2 challenge (PAYMENT-REQUIRED header) in the 402'); process.exit(1) }
if (req.network !== 'eip155:8453' || req.scheme !== 'exact') { console.log(`unsupported: ${req.scheme} on ${req.network}`); process.exit(1) }
console.log(`price: $${Number(req.amount) / 1e6} USDC to ${req.payTo}`)
const now = Math.floor(Date.now() / 1000)
const authorization = { from: acct.address, to: req.payTo, value: req.amount, validAfter: String(now - 60), validBefore: String(now + Math.min(300, req.maxTimeoutSeconds ?? 120)), nonce: toHex(crypto.getRandomValues(new Uint8Array(32))) }
const signature = await acct.signTypedData({
  domain: { name: req.extra?.name ?? 'USD Coin', version: req.extra?.version ?? '2', chainId: 8453, verifyingContract: req.asset },
  types: { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] },
  primaryType: 'TransferWithAuthorization',
  message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) } as any,
})
// The extensions are echoed back: that is what lets the facilitator catalog the endpoint (Bazaar).
const payment = { x402Version: 2, resource: pr.resource, accepted: req, payload: { signature, authorization }, extensions: pr.extensions }
const paid = await fetch(url, { headers: { 'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(payment)).toString('base64') } })
const receipt = paid.headers.get('payment-response')
console.log(`status ${paid.status}${receipt ? `; receipt ${Buffer.from(receipt, 'base64').toString()}` : ''}`)
const body = await paid.text()
console.log(body.slice(0, 1500))
