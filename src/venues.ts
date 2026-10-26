// One interface over the three venues so the desk can pair any buy venue with any sell venue.
import type { Hex } from 'viem'
import { pub } from './wallet.js'
import { balanceOf, swap as textileSwap } from './swap.js'
import { preview } from './textile.js'
import { uniQuotePath, uniSwapPath } from './uniswap.js'
import { mentoQuote, mentoSwap } from './mento.js'
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

const mento: Venue = {
  name: 'mento',
  gas: 300_000,
  quote: mentoQuote,
  swap: (tin, tout, amt, minOut) => mentoSwap(tin, tout, amt, minOut),
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
