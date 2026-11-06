// Aerodrome (Base) and Velodrome (Optimism) classic pools: "solidly" style, each pair has a stable pool
// (curve-like, for coins of similar value) and a volatile pool (x*y=k). Quotes and swaps go through the Router
// with a list of hops; a route may pass through one hub token.
import { encodeFunctionData, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import type { Token } from './chains.js'
import type { HopVenue } from './hop.js'

const factoryAbi = parseAbi(['function getPool(address tokenA, address tokenB, bool stable) view returns (address)'])
const routerAbi = parseAbi([
  'function getAmountsOut(uint256 amountIn, (address from, address to, bool stable, address factory)[] routes) view returns (uint256[] amounts)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, (address from, address to, bool stable, address factory)[] routes, address to, uint256 deadline) returns (uint256[] amounts)',
])
type Hop = { from: Address; to: Address; stable: boolean; factory: Address }

export function solidlyVenue(o: {
  name: string; router: Address; factory: Address; hubs: string[]
  pub: PublicClient; T: Record<string, Token>; me: Address
  rpc: <T>(f: () => Promise<T>) => Promise<T>
  toRaw: (t: string, a: bigint) => bigint; fromRaw: (t: string, a: bigint) => bigint
  send: (to: Address, data: Hex) => Promise<{ transactionHash: Hex }>
  ensureAllowance: (t: string, spender: Address, need: bigint) => Promise<void>
}): HopVenue {
  const { pub, T } = o
  const pairKey = (a: string, b: string) => [a, b].sort().join(':')
  const pools = new Map<string, number[]>() // "A:B" -> [1] stable, [0] volatile
  const addrs = new Map<string, string[]>()
  const hop = (a: string, b: string, stable: boolean): Hop => ({ from: T[a].address, to: T[b].address, stable, factory: o.factory })
  function routes(tin: string, tout: string): Hop[][] {
    const out: Hop[][] = []
    for (const s of pools.get(pairKey(tin, tout)) ?? []) out.push([hop(tin, tout, s === 1)])
    for (const h of o.hubs) {
      if (!T[h] || h === tin || h === tout) continue
      for (const s1 of pools.get(pairKey(tin, h)) ?? []) for (const s2 of pools.get(pairKey(h, tout)) ?? [])
        out.push([hop(tin, h, s1 === 1), hop(h, tout, s2 === 1)])
    }
    return out
  }
  async function best(tin: string, tout: string, amt: bigint) {
    const raw = o.toRaw(tin, amt)
    const qs = await Promise.all(routes(tin, tout).map(async (r) => {
      try {
        const amounts = await o.rpc(() => pub.readContract({ address: o.router, abi: routerAbi, functionName: 'getAmountsOut', args: [raw, r] }))
        return { r, out: amounts[amounts.length - 1] }
      } catch { return null }
    }))
    let b: { r: Hop[]; out: bigint } | null = null
    for (const q of qs) if (q && q.out > 0n && (!b || q.out > b.out)) b = q
    return b
  }
  const memo = new Map<string, { at: number; p: Promise<bigint | null> }>()
  return {
    name: o.name,
    gas: 200_000,
    pools,
    addrs,
    async discover(tokens) {
      const all = [...new Set(['USDT', ...o.hubs, ...tokens])].filter((t) => T[t])
      const pairs: [string, string, boolean][] = []
      for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) for (const s of [true, false]) pairs.push([all[i], all[j], s])
      const res = await pub.multicall({ allowFailure: true, contracts: pairs.map(([a, b, s]) => ({ address: o.factory, abi: factoryAbi, functionName: 'getPool', args: [T[a].address, T[b].address, s] } as const)) })
      pools.clear(); addrs.clear(); memo.clear()
      res.forEach((r, i) => {
        if (r.status !== 'success' || r.result === zeroAddress) return
        const [a, b, s] = pairs[i]
        addrs.set(String(r.result).toLowerCase(), [a, b])
        pools.set(pairKey(a, b), [...(pools.get(pairKey(a, b)) ?? []), s ? 1 : 0])
      })
      return addrs.size
    },
    quote(tin, tout, amt) {
      const k = `${tin}>${tout}:${amt}`, hit = memo.get(k)
      if (hit && Date.now() - hit.at < 4000) return hit.p
      if (memo.size > 5000) memo.clear()
      const p = best(tin, tout, amt).then((b) => (b ? o.fromRaw(tout, b.out) : null)).catch(() => null)
      memo.set(k, { at: Date.now(), p })
      return p
    },
    async swap(tin, tout, amt, minOut) {
      const b = await best(tin, tout, amt)
      if (!b) throw new Error(`no ${o.name} route ${tin} -> ${tout}`)
      const raw = o.toRaw(tin, amt)
      await o.ensureAllowance(tin, o.router, raw)
      const data = encodeFunctionData({ abi: routerAbi, functionName: 'swapExactTokensForTokens', args: [raw, o.toRaw(tout, minOut), b.r, o.me, BigInt(Math.floor(Date.now() / 1000) + 300)] })
      return (await o.send(o.router, data)).transactionHash
    },
  }
}
