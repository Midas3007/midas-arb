// An exchange reached through one hop: cash -> hub on `hubVenue`, then hub -> coin on `inner` (and back the same
// way). Used on Celo, where Mento trades USDm, not USDT: USDT <-> USDm goes through Uniswap's deep 0.01% pool.
// Each step is its own transaction; the second step sells exactly what the first delivered. If the second step
// fails, the hub coin left over is sold by the loss guard like any leftover.
import type { Venue } from '../engine.js'

export type HopVenue = Venue & { pools: Map<string, number[]>; addrs: Map<string, string[]>; discover(tokens: string[]): Promise<number> }

export function hopVenue(inner: HopVenue, hub: string, hubVenue: Venue, o: {
  balanceOf: (t: string) => Promise<bigint>
  received: (t: string, before: bigint, hash: `0x${string}`) => Promise<bigint>
  slippageBps?: bigint
  name?: string // default: the inner exchange's name
}): HopVenue {
  const slip = o.slippageBps ?? 30n
  const direct = (tin: string, tout: string) => tin !== 'USDT' && tout !== 'USDT'
  return {
    name: o.name ?? inner.name,
    gas: inner.gas + hubVenue.gas,
    pools: inner.pools,
    addrs: o.name ? new Map() : inner.addrs, // a named hop shares the inner exchange: it is watched once
    discover: (tokens) => (o.name ? Promise.resolve(0) : inner.discover(tokens)), // ...and discovered once
    async quote(tin, tout, amt) {
      if (direct(tin, tout) || tin === hub || tout === hub) return null // cash <-> hub itself is the hub venue's job
      if (tin === 'USDT') { const h = await hubVenue.quote('USDT', hub, amt); return h ? inner.quote(hub, tout, h) : null }
      const h = await inner.quote(tin, hub, amt)
      return h ? hubVenue.quote(hub, 'USDT', h) : null
    },
    async swap(tin, tout, amt, minOut) {
      const [first, second] = tin === 'USDT' ? [hubVenue, inner] : [inner, hubVenue]
      const q = await first.quote(tin, hub, amt)
      if (!q) throw new Error(`no ${first.name} quote ${tin} -> ${hub}`)
      const before = await o.balanceOf(hub)
      const h1 = await first.swap(tin, hub, amt, (q * (10_000n - slip)) / 10_000n)
      const got = await o.received(hub, before, h1)
      return second.swap(hub, tout, got, minOut)
    },
  }
}

// Several exchanges as one: quotes ask all of them, a swap goes through whichever quotes best right then.
// Used as the cash <-> hub step of a hop, so it always takes the cheapest way there.
export function bestOf(name: string, venues: () => Venue[]): Venue {
  async function pick(tin: string, tout: string, amt: bigint) {
    const qs = await Promise.all(venues().map(async (v) => ({ v, out: await v.quote(tin, tout, amt).catch(() => null) })))
    let b: { v: Venue; out: bigint } | null = null
    for (const q of qs) if (q.out && (!b || q.out > b.out)) b = { v: q.v, out: q.out }
    return b
  }
  return {
    name,
    get gas() { return Math.max(0, ...venues().map((v) => v.gas)) },
    async quote(tin, tout, amt) { return (await pick(tin, tout, amt))?.out ?? null },
    async swap(tin, tout, amt, minOut) {
      const b = await pick(tin, tout, amt)
      if (!b) throw new Error(`no route ${tin} -> ${tout}`)
      return b.v.swap(tin, tout, amt, minOut)
    },
  }
}
