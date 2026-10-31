// Textile FX on Celo (Kiyoshi's original second venue): an RFQ exchange whose market makers quote local
// currencies (cNGN, wBRL, wARS...) against USDT at real FX rates. On Celo those coins have one thin Uniswap
// pool each, so Textile is what makes them tradable: buy where it is cheap, sell where it is dear.
// Quotes: /v2/rfq/preview (free, no signature). Trades: a firm quote, then one transaction to Textile's reactor.
import crypto from 'node:crypto'
import { toHex, type Address, type Hex, type PrivateKeyAccount } from 'viem'
import type { Venue } from '../engine.js'
import type { Token } from './chains.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export type TextileVenue = Venue & { pools: Map<string, number[]>; addrs: Map<string, string[]>; discover(tokens: string[]): Promise<number> }

export function textileVenue(o: {
  api: string
  reactor: Address
  rpc: <T>(f: () => Promise<T>) => Promise<T>
  chainId: number
  account: PrivateKeyAccount
  T: Record<string, Token>
  toRaw: (t: string, a: bigint) => bigint
  fromRaw: (t: string, a: bigint) => bigint
  send: (to: Address, data: Hex) => Promise<{ transactionHash: Hex }>
  ensureAllowance: (t: string, spender: Address, need: bigint) => Promise<void>
  balanceOf: (t: string) => Promise<bigint>
}): TextileVenue {
  const V2 = `${o.api}/v2`
  const H = { 'Content-Type': 'application/json' }
  const unwrap = async (res: Response) => {
    const body: any = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`Textile ${res.status}: ${JSON.stringify(body.error ?? body).slice(0, 200)}`)
    return body.data
  }
  async function signTakerControl() {
    const nonce = toHex(crypto.randomBytes(32))
    const issuedAt = Date.now()
    const signature = await o.account.signTypedData({
      domain: { name: 'Textile Taker Control', version: '1', chainId: o.chainId },
      types: { TakerControl: [{ name: 'taker', type: 'address' }, { name: 'chainId', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }, { name: 'issuedAt', type: 'uint256' }] },
      primaryType: 'TakerControl',
      message: { taker: o.account.address, chainId: BigInt(o.chainId), nonce, issuedAt: BigInt(issuedAt) },
    })
    return { nonce, issuedAt, signature }
  }
  // Firm quote. Tries unsigned first (12h grant), signs proof of wallet control only when asked.
  async function requestQuote(leg: { sellToken: Address; buyToken: Address; sellAmount: string }) {
    const send = (extra: object = {}) => fetch(`${V2}/rfq/request`, {
      method: 'POST', headers: H, body: JSON.stringify({ chainId: o.chainId, ...leg, taker: o.account.address, ...extra }), signal: AbortSignal.timeout(75_000),
    })
    let res = await send()
    if (res.status === 401) {
      const body: any = await res.clone().json().catch(() => ({}))
      if (body?.error?.details?.reason === 'proof_of_control_required') res = await send({ takerProof: await signTakerControl() })
    }
    return unwrap(res)
  }

  const memo = new Map<string, { at: number; p: Promise<bigint | null> }>()
  return {
    name: 'textile',
    gas: 260_000,
    pools: new Map(),
    addrs: new Map(),
    async discover() { memo.clear(); return 0 },
    quote(tin, tout, amt) {
      const k = `${tin}>${tout}:${amt}`, hit = memo.get(k)
      if (hit && Date.now() - hit.at < 4000) return hit.p
      if (memo.size > 2000) memo.clear()
      const p = o.rpc(async () => {
        if (!o.T[tin] || !o.T[tout]) return null
        const r = await fetch(`${V2}/rfq/preview`, {
          method: 'POST', headers: H, signal: AbortSignal.timeout(15_000),
          body: JSON.stringify({ chainId: o.chainId, sellToken: o.T[tin].address, buyToken: o.T[tout].address, sellAmount: o.toRaw(tin, amt).toString() }),
        })
        const d = await unwrap(r)
        return d?.status === 'preview' ? o.fromRaw(tout, BigInt(d.buyAmount)) : null
      }).catch(() => null)
      memo.set(k, { at: Date.now(), p })
      return p
    },
    async swap(tin, tout, amt, minOut) {
      const raw = o.toRaw(tin, amt), sellToken = o.T[tin].address, buyToken = o.T[tout].address
      for (let i = 0; (await o.balanceOf(tin)) < raw; i++) { if (i >= 15) throw new Error(`not enough ${tin} for Textile`); await sleep(1000) }
      await o.ensureAllowance(tin, o.reactor, raw) // before quoting, so the quote window is not spent on approvals
      let q: any
      for (let i = 0; ; i++) {
        try { q = await requestQuote({ sellToken, buyToken, sellAmount: raw.toString() }); break } catch (e: any) {
          const msg = String(e.message)
          if (i < 3 && msg.includes('insufficient_funds')) { // a lagging node, or funds still reserved by an earlier quote
            const m = msg.match(/"retryAfterMs":(\d+)/)
            await sleep(m ? Math.min(Number(m[1]) + 2000, 120_000) : 3000)
            continue
          }
          throw e
        }
      }
      if (q.status === 'no_quote') throw new Error(`Textile no quote: ${q.reason}`)
      const reactor = String(q.quote.reactor).toLowerCase()
      if (reactor !== o.reactor.toLowerCase() || String(q.transactions.swap.to).toLowerCase() !== reactor) throw new Error(`unexpected Textile reactor ${q.quote.reactor}; refusing`)
      if (BigInt(q.quote.buyAmount) < o.toRaw(tout, minOut)) throw new Error('Textile firm quote below the minimum')
      if (Date.now() >= Date.parse(q.quote.expiresAt) - 3_000) throw new Error('Textile quote expired')
      const r = await o.send(q.transactions.swap.to as Address, q.transactions.swap.data as Hex)
      fetch(`${V2}/rfq/${q.rfqId}/submit`, { method: 'POST', headers: { ...H, 'X-Rfq-Claim': q.claimToken }, body: JSON.stringify({ txHash: r.transactionHash }) }).catch(() => {})
      return r.transactionHash
    },
  }
}
