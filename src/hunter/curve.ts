// Curve: where much of the stable-to-stable liquidity lives (EURe on Gnosis, EURC/EURe on Base, EUR/SGD/CAD
// pools on Polygon...). Pools are found through Curve's own API (cached 6 h), then quoted and swapped on-chain.
// A coin pair is traded inside one pool. Older pools number their coins with int128, newer ones with uint256:
// each pool's style is detected once with a tiny quote. Meta pools (a coin against a base pool's LP token)
// are traded through their underlying coins, so EURe/x3CRV on Gnosis trades EURe against WXDAI directly.
import { encodeFunctionData, parseAbi, type Address, type Hex, type PublicClient } from 'viem'
import type { Token } from './chains.js'
import type { HopVenue } from './hop.js'

const A128 = parseAbi([
  'function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)',
  'function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)',
  'function get_dy_underlying(int128 i, int128 j, uint256 dx) view returns (uint256)',
  'function exchange_underlying(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)',
])
const A256 = parseAbi([
  'function get_dy(uint256 i, uint256 j, uint256 dx) view returns (uint256)',
  'function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) returns (uint256)',
])
type Leg = { pool: Address; i: number; j: number; underlying: boolean; style?: '128' | '256' }

export function curveVenue(o: {
  apiChain: string; minTvlUsd?: number
  pub: PublicClient; T: Record<string, Token>
  rpc: <T>(f: () => Promise<T>) => Promise<T>
  toRaw: (t: string, a: bigint) => bigint; fromRaw: (t: string, a: bigint) => bigint
  send: (to: Address, data: Hex) => Promise<{ transactionHash: Hex }>
  ensureAllowance: (t: string, spender: Address, need: bigint) => Promise<void>
}): HopVenue {
  const { pub, T } = o
  const legs = new Map<string, Leg[]>() // "tin>tout" -> pools that swap it
  const pools = new Map<string, number[]>()
  const addrs = new Map<string, string[]>()
  const keyOf = () => new Map(Object.entries(T).map(([k, t]) => [t.address.toLowerCase(), k]))

  async function dy(l: Leg, raw: bigint): Promise<bigint> {
    if (l.underlying) return o.rpc(() => pub.readContract({ address: l.pool, abi: A128, functionName: 'get_dy_underlying', args: [BigInt(l.i), BigInt(l.j), raw] }))
    if (l.style === '256') return o.rpc(() => pub.readContract({ address: l.pool, abi: A256, functionName: 'get_dy', args: [BigInt(l.i), BigInt(l.j), raw] }))
    return o.rpc(() => pub.readContract({ address: l.pool, abi: A128, functionName: 'get_dy', args: [BigInt(l.i), BigInt(l.j), raw] }))
  }
  async function best(tin: string, tout: string, amt: bigint) {
    const raw = o.toRaw(tin, amt)
    const qs = await Promise.all((legs.get(`${tin}>${tout}`) ?? []).map(async (l) => {
      try { return { l, out: await dy(l, raw) } } catch { return null }
    }))
    let b: { l: Leg; out: bigint } | null = null
    for (const q of qs) if (q && q.out > 0n && (!b || q.out > b.out)) b = q
    return b
  }
  const memo = new Map<string, { at: number; p: Promise<bigint | null> }>()
  return {
    name: 'curve',
    gas: 250_000,
    pools,
    addrs,
    async discover() {
      const j: any = await fetch(`https://api.curve.finance/v1/getPools/all/${o.apiChain}`, { signal: AbortSignal.timeout(30_000) }).then((r) => r.json())
      const list: any[] = j?.data?.poolData ?? []
      const known = keyOf()
      legs.clear(); pools.clear(); addrs.clear(); memo.clear()
      for (const p of list) {
        if (Number(p.usdTotal ?? 0) < (o.minTvlUsd ?? 1000)) continue
        const sets: { coins: any[]; underlying: boolean }[] = [{ coins: p.coins ?? [], underlying: false }]
        if (p.isMetaPool && p.underlyingCoins?.length) sets.push({ coins: p.underlyingCoins, underlying: true })
        for (const { coins, underlying } of sets) {
          const ks = coins.map((c: any) => known.get(String(c.address).toLowerCase()))
          const ours = ks.map((k: string | undefined, i: number) => [k, i] as const).filter(([k]) => !!k) as [string, number][]
          if (ours.length < 2) continue
          for (const [a, i] of ours) for (const [b, jj] of ours) {
            if (a === b) continue
            const leg: Leg = { pool: p.address, i, j: jj, underlying }
            legs.set(`${a}>${b}`, [...(legs.get(`${a}>${b}`) ?? []), leg])
          }
          addrs.set(String(p.address).toLowerCase(), ours.map(([k]) => k))
          for (const [a] of ours) for (const [b] of ours) if (a < b) pools.set(`${a}:${b}`, [1])
        }
      }
      // Which numbering each plain pool uses: try a tiny quote both ways, once.
      const plain = [...new Set([...legs.values()].flat().filter((l) => !l.underlying))]
      await Promise.all(plain.map(async (l) => {
        const tiny = 10n ** 3n
        try { await o.rpc(() => pub.readContract({ address: l.pool, abi: A128, functionName: 'get_dy', args: [BigInt(l.i), BigInt(l.j), tiny] })); l.style = '128' }
        catch { l.style = '256' }
      }))
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
      if (!b) throw new Error(`no Curve pool ${tin} -> ${tout}`)
      const raw = o.toRaw(tin, amt), min = o.toRaw(tout, minOut), { l } = b
      await o.ensureAllowance(tin, l.pool, raw)
      const data = l.underlying
        ? encodeFunctionData({ abi: A128, functionName: 'exchange_underlying', args: [BigInt(l.i), BigInt(l.j), raw, min] })
        : l.style === '256'
          ? encodeFunctionData({ abi: A256, functionName: 'exchange', args: [BigInt(l.i), BigInt(l.j), raw, min] })
          : encodeFunctionData({ abi: A128, functionName: 'exchange', args: [BigInt(l.i), BigInt(l.j), raw, min] })
      return (await o.send(l.pool, data)).transactionHash
    },
  }
}
