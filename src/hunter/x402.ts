// x402: agents pay per call in USDC on Base. Both protocol versions are spoken, so every client can pay:
//   v2 (current): the 402 carries a base64 PaymentRequired in the PAYMENT-REQUIRED header; the client pays in
//                 PAYMENT-SIGNATURE; the receipt goes back in PAYMENT-RESPONSE. Network "eip155:8453".
//   v1 (legacy):  the same challenge as JSON in the 402 body; X-PAYMENT / X-PAYMENT-RESPONSE. Network "base".
// The challenge also carries the Bazaar discovery extension (what the endpoint takes and returns), which is how
// agent directories (the x402 Bazaar, x402scan) list it and how agents learn to call it.
//
// Settlement (X402_FACILITATOR_URL):
//   default  https://facilitator.payai.network: verifies the payment, settles it on-chain (it pays the gas) and
//            catalogs the endpoint in its Bazaar once paid calls go through. No account needed for normal volumes.
//   self     this server checks the signed EIP-3009 authorization itself and settles it from the bot wallet
//            (HUNTER_PRIVATE_KEY pays ~$0.002 gas a call). No third party, but no Bazaar listing either.
import { erc20Abi, parseAbi, parseSignature, verifyTypedData, type Address, type Hex } from 'viem'
import { CHAINS } from './chains.js'
import { clientsFor } from './clients.js'

export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address
const DEFAULT_FACILITATOR = 'https://facilitator.payai.network'

export type PayConfig = { priceAtomic: bigint; priceUsd: number; payTo: Address; facilitator: string }

// The payment settings, or why payments are off. Payments never go to a throwaway address: without HUNTER_PRIVATE_KEY,
// X402_PAY_TO (your own address) is required.
export function payConfig(walletAddress: () => Address): PayConfig | { off: string } {
  const priceUsd = Number(process.env.X402_PRICE_USD ?? '0')
  if (!(priceUsd > 0)) return { off: 'X402_PRICE_USD not set' }
  const facilitator = (process.env.X402_FACILITATOR_URL || DEFAULT_FACILITATOR).replace(/\/$/, '')
  const hasKey = !!process.env.HUNTER_PRIVATE_KEY
  if (facilitator === 'self' && !hasKey) return { off: 'X402_FACILITATOR_URL=self needs HUNTER_PRIVATE_KEY (it pays the settlement gas)' }
  const payTo = (process.env.X402_PAY_TO || (hasKey ? walletAddress() : '')) as Address
  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) return { off: 'set X402_PAY_TO to your own Base address (or HUNTER_PRIVATE_KEY)' }
  return { priceAtomic: BigInt(Math.round(priceUsd * 1e6)), priceUsd, payTo, facilitator }
}

// What an endpoint is, for the challenge and the Bazaar listing.
export type Endpoint = {
  url: string; description: string
  serviceName: string; tags: string[]; iconUrl?: string
  queryParams: Record<string, unknown>; queryProps: Record<string, object>
  pathParams?: Record<string, string>; pathProps?: Record<string, object>; routeTemplate?: string
  outputExample: object
}

const v2Requirement = (c: PayConfig) => ({
  scheme: 'exact', network: 'eip155:8453', amount: c.priceAtomic.toString(), asset: USDC_BASE, payTo: c.payTo,
  maxTimeoutSeconds: 120, extra: { name: 'USD Coin', version: '2' },
})
const v1Requirement = (c: PayConfig, e: Endpoint) => ({
  scheme: 'exact', network: 'base', maxAmountRequired: c.priceAtomic.toString(), resource: e.url, description: e.description,
  mimeType: 'application/json', payTo: c.payTo, maxTimeoutSeconds: 120, asset: USDC_BASE,
  outputSchema: { input: { type: 'http', method: 'GET', discoverable: true, queryParams: e.queryProps }, output: e.outputExample },
  extra: { name: 'USD Coin', version: '2' },
})
function bazaar(e: Endpoint) {
  const input: Record<string, unknown> = { type: 'http', method: 'GET', queryParams: e.queryParams }
  if (e.pathParams) input.pathParams = e.pathParams
  const inputProps: Record<string, object> = {
    type: { type: 'string', const: 'http' },
    method: { type: 'string', enum: ['GET', 'HEAD', 'DELETE'] },
    queryParams: { type: 'object', properties: e.queryProps },
  }
  if (e.pathProps) inputProps.pathParams = { type: 'object', properties: e.pathProps, required: Object.keys(e.pathProps) }
  return {
    info: { input, output: { type: 'json', example: e.outputExample } },
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
      properties: {
        input: { type: 'object', properties: inputProps, required: ['type', 'method'], additionalProperties: false },
        output: { type: 'object', properties: { type: { type: 'string' }, example: { type: 'object' } }, required: ['type'] },
      },
      required: ['input'],
    },
    ...(e.routeTemplate ? { routeTemplate: e.routeTemplate } : {}),
  }
}
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64')

// The 402 answer: v2 in the PAYMENT-REQUIRED header, v1 in the body.
export function challenge(c: PayConfig, e: Endpoint, error: string) {
  const resource: Record<string, unknown> = { url: e.url, description: e.description, mimeType: 'application/json', serviceName: e.serviceName, tags: e.tags }
  if (e.iconUrl) resource.iconUrl = e.iconUrl
  const v2 = { x402Version: 2, error, resource, accepts: [v2Requirement(c)], extensions: { bazaar: bazaar(e) } }
  const v1 = { x402Version: 1, error, accepts: [v1Requirement(c, e)] }
  return { headers: { 'PAYMENT-REQUIRED': b64(v2), 'Access-Control-Expose-Headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE' }, body: v1 }
}

export type Settled = { headers: Record<string, string> }
// A payment from the request headers: checked, and a function that settles it. A string means refused (why).
export async function acceptPayment(c: PayConfig, e: Endpoint, headers: Record<string, string | string[] | undefined>): Promise<{ settle: () => Promise<Settled> } | string> {
  const raw = String(headers['payment-signature'] ?? headers['x-payment'] ?? '')
  if (!raw) return 'payment required: send PAYMENT-SIGNATURE (x402 v2) or X-PAYMENT (v1)'
  let p: any
  try { p = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) } catch { return 'payment header is not base64 JSON' }
  const version = Number(p?.x402Version ?? 1)
  const requirement = version >= 2 ? v2Requirement(c) : v1Requirement(c, e)
  if (version >= 2) {
    const a = p?.accepted
    if (!a || a.scheme !== 'exact' || a.network !== 'eip155:8453' || String(a.asset).toLowerCase() !== USDC_BASE.toLowerCase() || String(a.payTo).toLowerCase() !== c.payTo.toLowerCase() || BigInt(a.amount ?? 0) < c.priceAtomic)
      return 'the payment does not match this endpoint (exact, eip155:8453, USDC, payTo, amount)'
  } else if (p?.scheme !== 'exact' || p?.network !== 'base') return 'only the exact scheme on Base is accepted'
  const respHeader = version >= 2 ? 'PAYMENT-RESPONSE' : 'X-PAYMENT-RESPONSE'
  const network = version >= 2 ? 'eip155:8453' : 'base'
  if (c.facilitator === 'self') {
    const r = await checkSelf(c, p)
    if (typeof r === 'string') return r
    return { settle: async () => ({ headers: { [respHeader]: b64({ success: true, transaction: await r.settle(), network, payer: r.payer }) } }) }
  }
  const body = { x402Version: version, paymentPayload: p, paymentRequirements: requirement }
  const post = async (path: string) => {
    const res = await fetch(`${c.facilitator}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000) })
    const j: any = await res.json().catch(() => ({}))
    if (!res.ok && !('isValid' in j) && !('success' in j)) throw new Error(`facilitator ${path}: HTTP ${res.status} ${JSON.stringify(j).slice(0, 160)}`)
    return j
  }
  const v = await post('verify').catch((err) => ({ isValid: false, invalidReason: String(err?.message ?? err) }))
  if (!v.isValid) return `payment refused: ${v.invalidReason ?? 'invalid'}`
  return {
    settle: async () => {
      const s = await post('settle')
      if (!s.success) throw new Error(`settlement failed: ${s.errorReason ?? 'unknown'}`)
      return { headers: { [respHeader]: b64({ success: true, transaction: s.transaction, network: s.network ?? network, payer: s.payer ?? v.payer }) } }
    },
  }
}

// ---------- self-settlement: check the EIP-3009 authorization here and send it from the bot wallet ----------
const usdcAbi = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
])
const authTypes = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
] } as const
const usedNonces = new Set<string>()

async function checkSelf(c: PayConfig, p: any): Promise<{ settle: () => Promise<Hex>; payer: Address } | string> {
  const a = p?.payload?.authorization, sig = p?.payload?.signature as Hex
  if (!a || !sig) return 'missing authorization or signature'
  const now = Math.floor(Date.now() / 1000)
  if (String(a.to).toLowerCase() !== c.payTo.toLowerCase()) return 'payment goes to the wrong address'
  if (BigInt(a.value) < c.priceAtomic) return 'payment too small'
  if (Number(a.validAfter) > now || Number(a.validBefore) < now + 6) return 'authorization not valid now'
  if (usedNonces.has(String(a.nonce).toLowerCase())) return 'nonce already used'
  const message = { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce }
  const ok = await verifyTypedData({ address: a.from, domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC_BASE }, types: authTypes, primaryType: 'TransferWithAuthorization', message, signature: sig }).catch(() => false)
  if (!ok) return 'bad signature'
  const cl = clientsFor(CHAINS.base)
  const [used, bal] = await Promise.all([
    cl.pub.readContract({ address: USDC_BASE, abi: usdcAbi, functionName: 'authorizationState', args: [a.from, a.nonce] }),
    cl.pub.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: 'balanceOf', args: [a.from] }),
  ])
  if (used) return 'nonce already used'
  if (bal < BigInt(a.value)) return 'payer has too little USDC'
  usedNonces.add(String(a.nonce).toLowerCase())
  const { r, s, v, yParity } = parseSignature(sig)
  const args = [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, Number(v ?? BigInt(27 + (yParity ?? 0))), r, s] as const
  return {
    payer: a.from,
    settle: async () => {
      const { request } = await cl.pub.simulateContract({ account: cl.account, address: USDC_BASE, abi: usdcAbi, functionName: 'transferWithAuthorization', args })
      const hash = await cl.wallet.writeContract(request as any)
      await cl.pub.waitForTransactionReceipt({ hash, timeout: 60_000 })
      return hash
    },
  }
}
