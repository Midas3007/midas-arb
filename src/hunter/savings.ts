// Other income 1: idle cash earns interest in Aave v3 between trades.
// Most of the time a chain's cash just waits for a gap. The treasury parks everything above a trading buffer in
// Aave (where the chain's cash token earns SAVINGS_MIN_APY or more; 3-7.5% on Base, Avalanche, Optimism in
// Oct 2026), and the desk pulls out what a trade needs, in the same lock, just before trading. Interest is booked
// in the ledger as profit ("yield"), so sweeps include it.
// Risk: Aave is a large, long-running lending market, but not risk-free; and if a market is 100% borrowed a
// withdrawal can fail for a while, in which case that trade is skipped. SAVINGS=0 turns this off.
import { encodeFunctionData, erc20Abi, parseAbi, type Address, type Hex } from 'viem'
import type { ChainClients } from './clients.js'

const poolAbi = parseAbi([
  'function getReserveData(address) view returns ((uint256 configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt))',
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
])

export const SAVINGS_ON = process.env.SAVINGS !== '0'
export const SAVINGS_MIN_APY = Number(process.env.SAVINGS_MIN_APY ?? '1')

type Info = { aToken: Address; apyPct: number; at: number }
const info = new Map<string, Info>()
// The aToken (a receipt that grows with interest) and today's supply APY for the chain's cash token.
export async function aaveInfo(c: ChainClients): Promise<Info | null> {
  if (!c.p.aave || !SAVINGS_ON) return null
  const hit = info.get(c.p.key)
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit
  const d: any = await c.pub.readContract({ address: c.p.aave, abi: poolAbi, functionName: 'getReserveData', args: [c.p.tokens.USDT.address] }).catch(() => null)
  if (!d || /^0x0+$/.test(d.aTokenAddress)) return null
  const r = { aToken: d.aTokenAddress as Address, apyPct: (Number(d.currentLiquidityRate) / 1e27) * 100, at: Date.now() }
  info.set(c.p.key, r)
  return r
}
// How much cash is parked, in the cash token's own units (aTokens are 1:1 with it, plus interest).
export async function parkedUnits(c: ChainClients): Promise<bigint> {
  const i = await aaveInfo(c)
  if (!i) return 0n
  return c.pub.readContract({ address: i.aToken, abi: erc20Abi, functionName: 'balanceOf', args: [c.account.address] }).catch(() => 0n)
}

type Send = (to: Address, data: Hex) => Promise<unknown>
export async function aaveSupply(c: ChainClients, amount: bigint, send: Send) {
  const asset = c.p.tokens.USDT.address, pool = c.p.aave!
  const have = await c.pub.readContract({ address: asset, abi: erc20Abi, functionName: 'allowance', args: [c.account.address, pool] })
  if (have < amount) {
    if (have > 0n) await send(asset, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [pool, 0n] }))
    await send(asset, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [pool, amount] }))
  }
  await send(pool, encodeFunctionData({ abi: poolAbi, functionName: 'supply', args: [asset, amount, c.account.address, 0] }))
}
export async function aaveWithdraw(c: ChainClients, amount: bigint, send: Send) {
  await send(c.p.aave!, encodeFunctionData({ abi: poolAbi, functionName: 'withdraw', args: [c.p.tokens.USDT.address, amount, c.account.address] }))
}

// Pure: what to do with a chain's cash. keepUsd stays liquid for trading; above it (by at least minMoveUsd) is
// parked; when liquid falls under half the buffer, enough comes back out to refill it.
export function parkPlan(liquidUsd: number, parkedUsd: number, keepUsd: number, minMoveUsd: number): { action: 'deposit' | 'withdraw'; usd: number } | null {
  const extra = liquidUsd - keepUsd
  if (extra >= minMoveUsd) return { action: 'deposit', usd: Math.floor(extra * 100) / 100 }
  if (liquidUsd < keepUsd / 2 && parkedUsd > 0.01) {
    const usd = Math.min(parkedUsd, keepUsd - liquidUsd)
    return usd >= 0.01 ? { action: 'withdraw', usd: Math.floor(usd * 100) / 100 } : null
  }
  return null
}
