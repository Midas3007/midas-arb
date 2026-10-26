// One interface over the three venues so the desk can pair any buy venue with any sell venue.
import type { Hex } from 'viem'
import { pub } from './wallet.js'
import { balanceOf, swap as textileSwap } from './swap.js'
import { preview } from './textile.js'
import { uniQuotePath, uniSwapPath } from './uniswap.js'
import { mentoQuote, mentoRoute, mentoSwap } from './mento.js'
import { TOKENS, VENUES, type TokenKey } from './config.js'
import type { Venue } from './engine.js'
export type { Venue }


const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// What a swap actually delivered: balance at the swap's block minus the balance before it.
// This, not the venue's quote, is what the next leg sells (a quote can be off by rounding or fees).
export async function received(token: TokenKey, before: bigint, hash: Hex): Promise<bigint> {
  const { blockNumber } = await pub.getTransactionReceipt({ hash })
  for (let i = 0; ; i++) {
    try { return (await balanceOf(TOKENS[token].address, blockNumber)) - before } catch (e) {
      if (i >= 10) throw e
      await sleep(1000) // public RPC nodes can be a block behind a fresh receipt
    }
  }
}

const uniswap: Venue = {
  name: 'uniswap',
  gas: 220_000,
  quote: async (tin, tout, amt) => (await uniQuotePath(tin, tout, amt))?.out ?? null,
  async swap(tin, tout, amt, minOut) {
    const q = await uniQuotePath(tin, tout, amt)
    if (!q) throw new Error(`No Uniswap route ${tin} -> ${tout}`)
    return uniSwapPath(tin, tout, amt, q.path, minOut)
  },
}

const textile: Venue = {
  name: 'textile',
  gas: 260_000,
  async quote(tin, tout, amt) {
    try {
      const p = await preview({ sellToken: TOKENS[tin].address, buyToken: TOKENS[tout].address, sellAmount: amt.toString() })
      return p.status === 'preview' ? BigInt(p.buyAmount) : null
    } catch { return null }
  },
  async swap(tin, tout, amt, minOut) {
    const r = await textileSwap(tin, tout, amt, minOut)
    if (r.status !== 'filled') throw new Error(`Textile ${r.status}${'reason' in r ? `: ${r.reason}` : ''}`)
    return r.txHash
  },
}

// Mento has no USDT exchange: its pools are USDm against each local currency. When Mento has no path from USDT,
// this venue enters and exits through USDm on Uniswap (USDT/USDm is a deep, cheap pool) and does the currency
// leg on Mento. USDT <-> USDm itself is left to Uniswap.
const HUB = 'USDm', HOP_SLIPPAGE_BPS = 30n
const viaHub = (tin: TokenKey, tout: TokenKey) =>
  !mentoRoute(tin, tout) && (tin === 'USDT' || tout === 'USDT') && tin !== HUB && tout !== HUB
const hubSwap = async (tin: TokenKey, tout: TokenKey, amt: bigint, minOut: bigint, venueSwap: Venue['swap']) => {
  const before = await balanceOf(TOKENS[tout].address)
  const hash = await venueSwap(tin, tout, amt, minOut)
  return { hash, got: await received(tout, before, hash) }
}

const mento: Venue = {
  name: 'mento',
  gas: 400_000,
  async quote(tin, tout, amt) {
    if (!viaHub(tin, tout)) return mentoQuote(tin, tout, amt)
    if (tin === 'USDT') {
      const hub = await uniswap.quote('USDT', HUB, amt)
      return hub ? mentoQuote(HUB, tout, hub) : null
    }
    const hub = await mentoQuote(tin, HUB, amt)
    return hub ? uniswap.quote(HUB, 'USDT', hub) : null
  },
  async swap(tin, tout, amt, minOut) {
    if (!viaHub(tin, tout)) return mentoSwap(tin, tout, amt, minOut)
    if (tin === 'USDT') {
      const q = await uniswap.quote('USDT', HUB, amt)
      if (!q) throw new Error('No Uniswap USDT -> USDm quote')
      const { got } = await hubSwap('USDT', HUB, amt, (q * (10_000n - HOP_SLIPPAGE_BPS)) / 10_000n, uniswap.swap)
      return mentoSwap(HUB, tout, got, minOut) // minOut is enforced on the final step
    }
    const q = await mentoQuote(tin, HUB, amt)
    if (!q) throw new Error(`No Mento ${tin} -> USDm quote`)
    const { got } = await hubSwap(tin, HUB, amt, (q * (10_000n - HOP_SLIPPAGE_BPS)) / 10_000n, mentoSwap)
    return uniswap.swap(HUB, 'USDT', got, minOut)
  },
}

// Identical quotes within a few seconds are served from memory. Routes share legs (the same Textile buy is the
// first leg of textile->uniswap and textile->mento), so this cuts RPC and Textile API calls a lot and keeps the
// bot under public rate limits.
const QUOTE_TTL_MS = 4000
function cached(v: Venue): Venue {
  const memo = new Map<string, { at: number; p: Promise<bigint | null> }>()
  return {
    ...v,
    quote(tin, tout, amt) {
      const k = `${tin}>${tout}:${amt}`
      const hit = memo.get(k)
      if (hit && Date.now() - hit.at < QUOTE_TTL_MS) return hit.p
      if (memo.size > 5000) memo.clear()
      const p = v.quote(tin, tout, amt).catch(() => null)
      memo.set(k, { at: Date.now(), p })
      return p
    },
  }
}

export const ALL_VENUES: Venue[] = [uniswap, textile, mento].filter((v) => VENUES.includes(v.name)).map(cached)
