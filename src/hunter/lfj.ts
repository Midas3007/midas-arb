// LFJ (Trader Joe) on Avalanche: Liquidity Book pools (prices in bins) plus its older AMM. LFJ's own quoter finds the
// best path over every version for a token route; routes tried: direct, and through each hub.
// Swaps go through the LB Router with the quoter's path (bin steps and versions), simulated before sending.
import { encodeFunctionData, parseAbi, type Address, type Hex, type PublicClient } from 'viem'
import type { Token } from './chains.js'
import type { HopVenue } from './hop.js'

export type LfjConfig = { quoter: Address; router: Address }
const quoterAbi = parseAbi(['function findBestPathFromAmountIn(address[] route, uint128 amountIn) view returns ((address[] route, address[] pairs, uint256[] binSteps, uint8[] versions, uint128[] amounts, uint128[] virtualAmountsWithoutSlippage, uint128[] fees))'])
const routerAbi = parseAbi(['function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, (uint256[] pairBinSteps, uint8[] versions, address[] tokenPath) path, address to, uint256 deadline) returns (uint256 amountOut)'])

export function lfjVenue(o: {
  cfg: LfjConfig; hubs: string[]
  pub: PublicClient; T: Record<string, Token>; me: Address
  rpc: <T>(f: () => Promise<T>) => Promise<T>
  toRaw: (t: string, a: bigint) => bigint; fromRaw: (t: string, a: bigint) => bigint
  send: (to: Address, data: Hex) => Promise<{ transactionHash: Hex }>
  ensureAllowance: (t: string, spender: Address, need: bigint) => Promise<void>
}): HopVenue {
  const { pub, T } = o
  type Q = { route: readonly Address[]; binSteps: readonly bigint[]; versions: readonly number[]; out: bigint }
  async function best(tin: string, tout: string, amt: bigint): Promise<Q | null> {
    if (!T[tin] || !T[tout]) return null
    const raw = o.toRaw(tin, amt)
    const routes: Address[][] = [[T[tin].address, T[tout].address], ...o.hubs.filter((h) => T[h] && h !== tin && h !== tout).map((h) => [T[tin].address, T[h].address, T[tout].address])]
    let b: Q | null = null
    await Promise.all(routes.map(async (r) => {
      try {
        const q: any = await o.rpc(() => pub.readContract({ address: o.cfg.quoter, abi: quoterAbi, functionName: 'findBestPathFromAmountIn', args: [r, raw] }))
        const out = BigInt(q.amounts[q.amounts.length - 1] ?? 0)
        if (out > 0n && (!b || out > b.out)) b = { route: q.route, binSteps: q.binSteps, versions: q.versions, out }
      } catch { /* no pool on this route */ }
    }))
    return b
  }
  const memo = new Map<string, { at: number; p: Promise<bigint | null> }>()
  return {
    name: 'lfj',
    gas: 260_000,
    pools: new Map(),
    addrs: new Map(),
    async discover() { memo.clear(); return 0 },
    quote(tin, tout, amt) {
      const k = `${tin}>${tout}:${amt}`, hit = memo.get(k)
      if (hit && Date.now() - hit.at < 4000) return hit.p
      if (memo.size > 5000) memo.clear()
      const p = best(tin, tout, amt).then((q) => (q ? o.fromRaw(tout, q.out) : null)).catch(() => null)
      memo.set(k, { at: Date.now(), p })
      return p
    },
    async swap(tin, tout, amt, minOut) {
      const q = await best(tin, tout, amt)
      if (!q) throw new Error(`no LFJ route ${tin} -> ${tout}`)
      const raw = o.toRaw(tin, amt)
      await o.ensureAllowance(tin, o.cfg.router, raw)
      const data = encodeFunctionData({ abi: routerAbi, functionName: 'swapExactTokensForTokens', args: [raw, o.toRaw(tout, minOut), { pairBinSteps: [...q.binSteps], versions: [...q.versions], tokenPath: [...q.route] }, o.me, BigInt(Math.floor(Date.now() / 1000) + 300)] })
      return (await o.send(o.cfg.router, data)).transactionHash
    },
  }
}
