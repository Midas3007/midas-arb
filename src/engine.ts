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

export async function bestSize(route: Route, minSize: bigint, maxSize: bigint, gasUsd: number): Promise<Opp | null> {
  if (maxSize < minSize || minSize <= 0n) return null
  const ladder = sizeLadder(minSize, maxSize)
  const rungs = (await Promise.all(ladder.map((s) => evaluate(route, s, gasUsd).catch(() => null)))).filter(Boolean) as Opp[]
  if (!rungs.length) return null
  rungs.sort((a, b) => b.net - a.net)
  const best = rungs[0]
  if (best.net <= 0) return best
  const i = ladder.indexOf(best.size)
  const probes = [ladder[i - 1], ladder[i + 1]].filter((n): n is bigint => n !== undefined).map((n) => (best.size + n) / 2n)
  const refined = (await Promise.all(probes.map((s) => evaluate(route, s, gasUsd).catch(() => null)))).filter(Boolean) as Opp[]
  return [best, ...refined].sort((a, b) => b.net - a.net)[0]
}

export async function scanRoutes(routes: Route[], minSize: bigint, maxSize: bigint, gasUsdFor: (r: Route) => number): Promise<Opp[]> {
  const found = await Promise.all(routes.map((r) => bestSize(r, minSize, maxSize, gasUsdFor(r)).catch(() => null)))
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
