// Uniswap v4 (one PoolManager for every pool). On Robinhood Chain this is where stock tokens trade directly against
// USDG, at several fee tiers. Pools are found without scanning logs: for each coin and each standard tier
// (0.01%/1, 0.05%/10, 0.3%/60, 1%/200, no hooks), a $1 quote from V4Quoter shows whether the pool exists and
// has liquidity. Pools with hooks are not used (a hook can change what a swap does).
// One venue per fee tier, so the desk can trade between a coin's tiers (buy where cheap, sell where dear).
// Swaps go through the Universal Router (V4_SWAP: SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL), paying through
// Permit2. Every transaction is simulated before it is sent.
import { encodeAbiParameters, encodeFunctionData, encodePacked, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import type { Token } from './chains.js'
import type { HopVenue } from './hop.js'

export type V4Config = { poolManager: Address; quoter: Address; routers: Address[]; permit2: Address }
type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }
export const V4_TIERS: [number, number][] = [[100, 1], [500, 10], [3000, 60], [10000, 200]]

const quoterAbi = parseAbi(['function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)'])
const permit2Abi = parseAbi(['function allowance(address,address,address) view returns (uint160 amount,uint48 expiration,uint48 nonce)', 'function approve(address token,address spender,uint160 amount,uint48 expiration)'])
const urAbi = parseAbi(['function execute(bytes commands,bytes[] inputs,uint256 deadline) payable'])
const keyType = { type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] } as const

// Pure: the standard pool key for two tokens at a tier (currencies sorted by address, no hooks).
export function poolKey(a: Address, b: Address, fee: number, tickSpacing: number): PoolKey {
  const [c0, c1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]
  return { currency0: c0, currency1: c1, fee, tickSpacing, hooks: zeroAddress }
}

export function v4Venue(o: {
  v4: V4Config; router: Address; tier: [number, number]; bases: string[] // pools are looked for between each coin and these
  pub: PublicClient; T: Record<string, Token>; me: Address
  rpc: <T>(f: () => Promise<T>) => Promise<T>
  toRaw: (t: string, a: bigint) => bigint; fromRaw: (t: string, a: bigint) => bigint
  send: (to: Address, data: Hex) => Promise<{ transactionHash: Hex }>
  ensureAllowance: (t: string, spender: Address, need: bigint) => Promise<void>
}): HopVenue {
  const { pub, T } = o
  const [fee, ts] = o.tier
  const keys = new Map<string, PoolKey>() // "A:B" sorted -> key
  const pairKey = (a: string, b: string) => [a, b].sort().join(':')
  async function quoteKey(k: PoolKey, tin: string, raw: bigint): Promise<bigint | null> {
    const zeroForOne = k.currency0.toLowerCase() === T[tin].address.toLowerCase()
    try {
      const { result } = await o.rpc(() => pub.simulateContract({ address: o.v4.quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ poolKey: k, zeroForOne, exactAmount: raw, hookData: '0x' }] }))
      return result[0] > 0n ? result[0] : null
    } catch { return null }
  }
  const memo = new Map<string, { at: number; p: Promise<bigint | null> }>()
  const name = `uniswap-v4/${fee / 10_000}%`
  return {
    name,
    gas: 230_000,
    pools: new Map(),
    addrs: new Map(),
    async discover(tokens) {
      keys.clear(); memo.clear()
      const jobs: Promise<void>[] = []
      for (const base of o.bases.filter((b) => T[b])) for (const X of tokens) {
        if (X === base || !T[X]) continue
        jobs.push((async () => {
          const k = poolKey(T[base].address, T[X].address, fee, ts)
          const probe = base === 'USDT' ? 1_000_000n : 10n ** BigInt(Math.max(0, T[base].decimals - 3)) // $1 of cash, or 0.001 of a hub
          if (await quoteKey(k, base, o.toRaw(base, probe))) keys.set(pairKey(base, X), k)
        })())
      }
      await Promise.all(jobs)
      return keys.size
    },
    quote(tin, tout, amt) {
      const k = keys.get(pairKey(tin, tout))
      if (!k) return Promise.resolve(null)
      const mk = `${tin}>${tout}:${amt}`, hit = memo.get(mk)
      if (hit && Date.now() - hit.at < 4000) return hit.p
      if (memo.size > 5000) memo.clear()
      const p = quoteKey(k, tin, o.toRaw(tin, amt)).then((r) => (r ? o.fromRaw(tout, r) : null))
      memo.set(mk, { at: Date.now(), p })
      return p
    },
    async swap(tin, tout, amt, minOut) {
      const k = keys.get(pairKey(tin, tout))
      if (!k) throw new Error(`no ${name} pool ${tin} -> ${tout}`)
      const raw = o.toRaw(tin, amt), min = o.toRaw(tout, minOut)
      const zeroForOne = k.currency0.toLowerCase() === T[tin].address.toLowerCase()
      // token -> Permit2 allowance, then Permit2 -> router allowance
      await o.ensureAllowance(tin, o.v4.permit2, raw)
      const [pAmt, pExp] = await pub.readContract({ address: o.v4.permit2, abi: permit2Abi, functionName: 'allowance', args: [o.me, T[tin].address, o.router] })
      if (pAmt < raw || pExp < Math.floor(Date.now() / 1000) + 600) {
        const amount = raw * 4n > 2n ** 160n - 1n ? 2n ** 160n - 1n : raw * 4n
        await o.send(o.v4.permit2, encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [T[tin].address, o.router, amount, Math.floor(Date.now() / 1000) + 30 * 86400] }))
      }
      const params = [
        encodeAbiParameters([{ type: 'tuple', components: [{ name: 'poolKey', ...keyType }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'hookData', type: 'bytes' }] }],
          [{ poolKey: k, zeroForOne, amountIn: raw, amountOutMinimum: min, hookData: '0x' }]),
        encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [T[tin].address, raw]), // SETTLE_ALL (max to pay)
        encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [T[tout].address, min]), // TAKE_ALL (min to receive)
      ]
      const input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [encodePacked(['uint8', 'uint8', 'uint8'], [0x06, 0x0c, 0x0f]), params])
      const data = encodeFunctionData({ abi: urAbi, functionName: 'execute', args: ['0x10', [input], BigInt(Math.floor(Date.now() / 1000) + 300)] })
      return (await o.send(o.router, data)).transactionHash
    },
  }
}
