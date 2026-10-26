import { encodeFunctionData, encodePacked, erc20Abi, parseAbi, parseEventLogs, type Hex } from 'viem'
import { account, pub, sendTaggedReceipt } from './wallet.js'
import { ensureAllowance } from './swap.js'
import { TOKENS, UNI, UNI_HUBS, type TokenKey } from './config.js'

const quoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)',
])
const routerAbi = parseAbi([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
  'function factory() view returns (address)',
])

let routerVerified = false
async function verifyRouter() {
  if (routerVerified) return
  const f = await pub.readContract({ address: UNI.ROUTER, abi: routerAbi, functionName: 'factory' })
  if (f.toLowerCase() !== UNI.FACTORY.toLowerCase()) throw new Error(`Router factory mismatch (${f}), refusing to trade`)
  routerVerified = true
}

// Best quote across v3 fee tiers. Read-only.
export async function uniQuote(tin: TokenKey, tout: TokenKey, amountIn: bigint) {
  let best: { out: bigint; fee: number } | null = null
  for (const fee of [100, 500, 3000, 10000]) {
    try {
      const { result } = await pub.simulateContract({
        address: UNI.QUOTER, abi: quoterAbi, functionName: 'quoteExactInputSingle',
        args: [{ tokenIn: TOKENS[tin].address, tokenOut: TOKENS[tout].address, amountIn, fee, sqrtPriceLimitX96: 0n }],
      })
      if (!best || result[0] > best.out) best = { out: result[0], fee }
    } catch {}
  }
  return best
}

// Tagged swap through SwapRouter02. Reverts onchain if output < minOut.
// Returns the amount received, read from the swap's own receipt (never a stale balance read).
export async function uniSwap(tin: TokenKey, tout: TokenKey, amountIn: bigint, fee: number, minOut: bigint): Promise<{ hash: Hex; out: bigint }> {
  await verifyRouter()
  await ensureAllowance(TOKENS[tin].address, UNI.ROUTER, amountIn)
  const receipt = await sendTaggedReceipt({
    to: UNI.ROUTER,
    data: encodeFunctionData({
      abi: routerAbi,
      functionName: 'exactInputSingle',
      args: [{
        tokenIn: TOKENS[tin].address, tokenOut: TOKENS[tout].address, fee,
        recipient: account.address, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n,
      }],
    }),
  })
  const out = parseEventLogs({ abi: erc20Abi, logs: receipt.logs, eventName: 'Transfer' })
    .filter((l) => l.address.toLowerCase() === TOKENS[tout].address.toLowerCase() && l.args.to.toLowerCase() === account.address.toLowerCase())
    .reduce((sum, l) => sum + l.args.value, 0n)
  if (out === 0n) throw new Error(`Swap ${receipt.transactionHash} succeeded but no ${tout} transfer to the agent was found`)
  return { hash: receipt.transactionHash, out }
}

// ---------- multi-hop routing (desk) ----------
// Pools are discovered once (factory.getPool for every pair and fee tier, one multicall). A route is either a
// direct pool or one hop through a hub token (USDC, USDm, CELO). Every candidate path is quoted in parallel.
const factoryAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)'])
const pathQuoterAbi = parseAbi(['function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[], uint32[], uint256 gasEstimate)'])
const pathRouterAbi = parseAbi(['function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256 amountOut)'])
const FEES = [100, 500, 3000, 10000] as const
const ZERO = '0x0000000000000000000000000000000000000000'

type Hop = { from: TokenKey; to: TokenKey; fee: number }
const pools = new Map<string, number[]>()
const pairOf = (a: TokenKey, b: TokenKey) => [a, b].sort().join(':')

export async function uniDiscover(tokens: TokenKey[]) {
  const all = [...new Set<TokenKey>(['USDT', ...UNI_HUBS, ...tokens])]
  const pairs: [TokenKey, TokenKey][] = []
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) pairs.push([all[i], all[j]])
  const res = await pub.multicall({
    allowFailure: true,
    contracts: pairs.flatMap(([a, b]) => FEES.map((fee) => ({ address: UNI.FACTORY, abi: factoryAbi, functionName: 'getPool', args: [TOKENS[a].address, TOKENS[b].address, fee] } as const))),
  })
  pools.clear()
  res.forEach((r, i) => {
    if (r.status !== 'success' || r.result === ZERO) return
    const [a, b] = pairs[Math.floor(i / FEES.length)]
    const k = pairOf(a, b)
    pools.set(k, [...(pools.get(k) ?? []), FEES[i % FEES.length]])
  })
  return pools.size
}

function uniPaths(tin: TokenKey, tout: TokenKey): Hop[][] {
  const fees = (a: TokenKey, b: TokenKey) => pools.get(pairOf(a, b)) ?? []
  const out: Hop[][] = fees(tin, tout).map((fee) => [{ from: tin, to: tout, fee }])
  for (const hub of UNI_HUBS) {
    if (hub === tin || hub === tout) continue
    for (const f1 of fees(tin, hub)) for (const f2 of fees(hub, tout)) out.push([{ from: tin, to: hub, fee: f1 }, { from: hub, to: tout, fee: f2 }])
  }
  return out
}

function encodePath(hops: Hop[]): Hex {
  const types: string[] = ['address'], values: unknown[] = [TOKENS[hops[0].from].address]
  for (const h of hops) { types.push('uint24', 'address'); values.push(h.fee, TOKENS[h.to].address) }
  return encodePacked(types as any, values as any)
}

export async function uniQuotePath(tin: TokenKey, tout: TokenKey, amountIn: bigint): Promise<{ out: bigint; path: Hex } | null> {
  const candidates = uniPaths(tin, tout)
  if (!candidates.length || amountIn <= 0n) return null
  const quotes = await Promise.all(candidates.map(async (hops) => {
    const path = encodePath(hops)
    try {
      const { result } = await pub.simulateContract({ address: UNI.QUOTER, abi: pathQuoterAbi, functionName: 'quoteExactInput', args: [path, amountIn] })
      return { out: result[0], path }
    } catch { return null }
  }))
  let best: { out: bigint; path: Hex } | null = null
  for (const q of quotes) if (q && (!best || q.out > best.out)) best = q
  return best
}

export async function uniSwapPath(tin: TokenKey, tout: TokenKey, amountIn: bigint, path: Hex, minOut: bigint): Promise<Hex> {
  await verifyRouter()
  await ensureAllowance(TOKENS[tin].address, UNI.ROUTER, amountIn)
  const receipt = await sendTaggedReceipt({
    to: UNI.ROUTER,
    data: encodeFunctionData({ abi: pathRouterAbi, functionName: 'exactInput', args: [{ path, recipient: account.address, amountIn, amountOutMinimum: minOut }] }),
  })
  return receipt.transactionHash
}
