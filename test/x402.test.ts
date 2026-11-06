import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acceptPayment, challenge, v2Requirements, type Endpoint, type PayConfig } from '../src/hunter/x402.js'

const payTo = '0x6Cd37bC290c5c02EA92086d416a6A673BCA581dC'
const base: PayConfig = { priceAtomic: 10_000n, priceUsd: 0.01, payTo, facilitator: 'https://fac.example' }
const withCelo: PayConfig = { ...base, celo: { apiKey: 'k123', payTo, facilitator: 'https://celo.example' } }
const ep: Endpoint = { url: 'https://api.example/fx/NGN', description: 'd', serviceName: 's', tags: [], queryParams: { size: 1000 }, queryProps: {}, outputExample: {} }
const decode = (h: string) => JSON.parse(Buffer.from(h, 'base64').toString())
const header = (accepted: object) => Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload: { signature: '0x', authorization: {} } })).toString('base64')

test('x402: the challenge offers Base only, or Base plus USDT and USDC on Celo with their EIP-712 domains', () => {
  assert.equal(decode(challenge(base, ep, 'x').headers['PAYMENT-REQUIRED']).accepts.length, 1)
  const acc = decode(challenge(withCelo, ep, 'x').headers['PAYMENT-REQUIRED']).accepts
  assert.deepEqual(acc.map((a: any) => `${a.network} ${a.extra.name} ${a.extra.version}`), ['eip155:8453 USD Coin 2', 'eip155:42220 Tether USD 1', 'eip155:42220 USDC 2'])
})

test('x402: a Celo payment goes to the Celo facilitator with the API key; a wrong asset or amount is refused', async () => {
  const calls: { url: string; key: string | null }[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), key: new Headers(init?.headers).get('x-api-key') })
    return new Response(JSON.stringify(String(url).endsWith('/verify') ? { isValid: true, payer: '0xabc' } : { success: true, transaction: '0xtx', network: 'eip155:42220' }), { status: 200 })
  }) as any
  try {
    const usdt = v2Requirements(withCelo)[1]
    const r = await acceptPayment(withCelo, ep, { 'payment-signature': header(usdt) })
    assert.notEqual(typeof r, 'string')
    const s = await (r as any).settle()
    assert.deepEqual(calls.map((c) => c.url), ['https://celo.example/verify', 'https://celo.example/settle'])
    assert.ok(calls.every((c) => c.key === 'k123'))
    assert.equal(decode(s.headers['PAYMENT-RESPONSE']).network, 'eip155:42220')
    // Base payments still go to the default facilitator, without the Celo key
    calls.length = 0
    await acceptPayment(withCelo, ep, { 'payment-signature': header(v2Requirements(withCelo)[0]) })
    assert.equal(calls[0].url, 'https://fac.example/verify'); assert.equal(calls[0].key, null)
    // refused before any facilitator call: unknown asset, short amount, Celo when Celo is off
    calls.length = 0
    assert.equal(typeof (await acceptPayment(withCelo, ep, { 'payment-signature': header({ ...usdt, asset: '0x0000000000000000000000000000000000000001' }) })), 'string')
    assert.equal(typeof (await acceptPayment(withCelo, ep, { 'payment-signature': header({ ...usdt, amount: '1' }) })), 'string')
    assert.equal(typeof (await acceptPayment(base, ep, { 'payment-signature': header(usdt) })), 'string')
    assert.equal(calls.length, 0)
  } finally { globalThis.fetch = real }
})
