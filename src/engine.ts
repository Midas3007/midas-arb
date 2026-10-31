// Pure trading logic: routes, size search, the loss guard and the daily kill switch.
// No chain access here, so all of it is unit-tested with fake venues (test/engine.test.ts).
import type { Hex } from 'viem'
import type { TokenKey } from './config.js'

export interface Venue {
  name: string
  gas: number // typical gas units per swap, for the profit-after-gas check
  quote(tin: TokenKey, tout: TokenKey, amountIn: bigint): Promise<bigint | null>
  // Must complete or throw. minOut: refuse to trade (or revert on-chain) for less.
  swap(tin: TokenKey, tout: TokenKey, amountIn: bigint, minOut: bigint): Promise<Hex>
}

export type Route = { X: TokenKey; buy: Venue; sell: Venue }
export type Opp = { route: Route; size: bigint; mid: bigint; out: bigint; edge: number; gasUsd: number; net: number }

export const usdOf = (v: bigint) => Number(v) / 1e6 // USDT has 6 decimals
export const routeKey = (r: Route) => `${r.X}:${r.buy.name}>${r.sell.name}`
export const routeName = (r: Route) => `${r.X} ${r.buy.name}->${r.sell.name}`

// Every ordered pair of different venues that can both trade X.
export function buildRoutes(supported: Map<string, Set<TokenKey>>, venues: Venue[]): Route[] {
  const out: Route[] = []
  const tokens = new Set<TokenKey>()
  for (const set of supported.values()) for (const t of set) tokens.add(t)
  for (const X of tokens) for (const buy of venues) for (const sell of venues) {
    if (buy !== sell && supported.get(buy.name)?.has(X) && supported.get(sell.name)?.has(X)) out.push({ X, buy, sell })
  }
  return out
}

async function evaluate(route: Route, size: bigint, gasUsd: number): Promise<Opp | null> {
  const mid = await route.buy.quote('USDT', route.X, size)
  if (!mid || mid <= 0n) return null
  const out = await route.sell.quote(route.X, 'USDT', mid)
  if (!out) return null
  const edge = usdOf(out) - usdOf(size)
  return { route, size, mid, out, edge, gasUsd, net: edge - gasUsd }
}

// Profit is roughly concave in size: bigger trades move AMM prices against you. Try sizes spread evenly on a
// log scale from minSize to maxSize (so small optimums are not missed), then probe between the best size and
// its neighbours. All quotes run in parallel.
export function sizeLadder(minSize: bigint, maxSize: bigint, rungs = 6): bigint[] {
  if (maxSize <= minSize) return [maxSize]
  const lo = Math.log(Number(minSize)), hi = Math.log(Number(maxSize))
  const out = new Set<bigint>()
  for (let i = 0; i < rungs; i++) out.add(BigInt(Math.round(Math.exp(hi - ((hi - lo) * i) / (rungs - 1)))))
  return [...out]
}

// How much worse the exit (sell leg) price is at this size than in a tiny trade, in basis points. The buy leg is
// left alone on purpose: moving a dislocated pool back toward fair is where the profit comes from. The exit is
// meant to be a deep pool, so a big move there means the trade is too large for it.
export function exitImpactBps(o: Opp, probe: Opp): number {
  if (o.mid <= 0n || probe.mid <= 0n || probe.out <= 0n) return 0
  const unit = Number(o.out) / Number(o.mid), unit0 = Number(probe.out) / Number(probe.mid)
  return unit0 > 0 ? Math.max(0, (1 - unit / unit0) * 10_000) : 0
}

export async function bestSize(route: Route, minSize: bigint, maxSize: bigint, gasUsd: number, maxExitImpactBps = Infinity, probe?: Opp): Promise<Opp | null> {
  if (maxSize < minSize || minSize <= 0n) return null
  const ladder = sizeLadder(minSize, maxSize)
  const fits = (o: Opp) => !probe || exitImpactBps(o, probe) <= maxExitImpactBps
  const rungs = ((await Promise.all(ladder.map((s) => evaluate(route, s, gasUsd).catch(() => null)))).filter(Boolean) as Opp[]).filter(fits)
  if (!rungs.length) return null
  rungs.sort((a, b) => b.net - a.net)
  const best = rungs[0]
  if (best.net <= 0) return best
  const i = ladder.indexOf(best.size)
  const probes = [ladder[i - 1], ladder[i + 1]].filter((n): n is bigint => n !== undefined).map((n) => (best.size + n) / 2n)
  const refined = ((await Promise.all(probes.map((s) => evaluate(route, s, gasUsd).catch(() => null)))).filter(Boolean) as Opp[]).filter(fits)
  return [best, ...refined].sort((a, b) => b.net - a.net)[0]
}

// The smallest trade gets the best price (no price impact), so a route that loses before gas at minSize loses at
// every size: one quote rules it out, and only routes with a positive edge get the full size search.
// This cuts the RPC work of a scan by most of it.
// maxExitImpactBps: sizes that move the exit pool's price more than this are not considered (see exitImpactBps).
// Prefilter: with many pools per coin, quoting every route exactly is slow. Instead each venue is asked once per
// coin for a buy price and once for a sell price (on a common token amount), every route's edge is estimated from
// those, and only routes that come out (nearly) positive get exact quotes. At these tiny sizes prices are close to
// linear, and a small allowance (0.1% of the trade) keeps borderline routes in.
export async function prefilterRoutes(routes: Route[], probe: bigint): Promise<Route[]> {
  const coins = [...new Set(routes.map((r) => r.X))]
  const keep: Route[] = []
  await Promise.all(coins.map(async (X) => {
    const rs = routes.filter((r) => r.X === X)
    const venues = [...new Set(rs.flatMap((r) => [r.buy, r.sell]))]
    const buys = new Map<Venue, bigint>()
    await Promise.all(venues.map(async (v) => { const q = await v.quote('USDT', X, probe).catch(() => null); if (q && q > 0n) buys.set(v, q) }))
    if (!buys.size) return
    const ref = [...buys.values()].reduce((a, b) => (b > a ? b : a))
    const sells = new Map<Venue, bigint>()
    await Promise.all(venues.map(async (v) => { const q = await v.quote(X, 'USDT', ref).catch(() => null); if (q && q > 0n) sells.set(v, q) }))
    for (const r of rs) {
      const b = buys.get(r.buy), sl = sells.get(r.sell)
      if (!b || !sl) continue
      const est = (sl * b) / ref // dollars back from selling what $probe bought on r.buy
      if (est * 1000n >= probe * 999n) keep.push(r)
    }
  }))
  return keep
}

// maxExitImpactBps: sizes that move the exit pool's price more than this are not considered (see exitImpactBps).
// probeSize: the size each route is first tested at (default minSize). A realistic size ($10) avoids rounding and
// fixed-fee effects that make tiny test trades look worse than real ones.
export async function scanRoutes(routes: Route[], minSize: bigint, maxSize: bigint, gasUsdFor: (r: Route) => number, maxExitImpactBps = Infinity, probeSize?: bigint): Promise<Opp[]> {
  const testAt = probeSize && probeSize > minSize ? (probeSize < maxSize ? probeSize : maxSize) : minSize
  const found = await Promise.all(routes.map(async (r) => {
    const probe = await evaluate(r, testAt, gasUsdFor(r)).catch(() => null)
    if (!probe || probe.edge <= 0) return probe
    return bestSize(r, minSize, maxSize, gasUsdFor(r), maxExitImpactBps, probe).catch(() => probe)
  }))
  return (found.filter(Boolean) as Opp[]).sort((a, b) => b.net - a.net)
}

// Leftover inventory: sell if the best exit loses at most maxLossBps of what it cost, or once it has been held
// longer than maxHoldMs (then any price, to cap currency risk).
export function shouldSell(exitOut: bigint, costUsdt: bigint, heldMs: number, maxLossBps: number, maxHoldMs: number): boolean {
  const floor = (costUsdt * BigInt(10_000 - maxLossBps)) / 10_000n
  return exitOut >= floor || heldMs >= maxHoldMs
}

// Daily kill switch: stop opening trades once today's realized loss reaches the limit.
export function tradingAllowed(todayPnl: number, maxDailyLoss: number): boolean {
  return maxDailyLoss <= 0 || todayPnl > -maxDailyLoss
}
