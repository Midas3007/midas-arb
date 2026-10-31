// Other income 2: reward tokens the wallet has earned, claimed automatically.
// Merkl pays most of today's incentive programs (Aave and pool incentives, swap rewards...) through one
// Distributor contract on every chain. Every REWARDS_MIN minutes (default 60) the treasury asks Merkl's API what
// this wallet may claim; once it is worth REWARDS_MIN_USD ($1) on a chain, it is claimed and booked in the ledger
// as profit. Reward tokens that are not the cash token are swapped to cash by the same treasury round.
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import type { ChainClients } from './clients.js'

export const DISTRIBUTOR = '0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae' as Address
const distAbi = parseAbi(['function claim(address[] users, address[] tokens, uint256[] amounts, bytes32[][] proofs)'])

export type Claimable = { token: Address; symbol: string; decimals: number; total: bigint; unclaimed: bigint; usd: number; proofs: Hex[] }

// What this wallet can claim on a chain (amounts are cumulative; the contract pays the unclaimed difference).
export async function claimable(chainId: number, user: Address): Promise<Claimable[]> {
  const j: any = await fetch(`https://api.merkl.xyz/v4/users/${user}/rewards?chainId=${chainId}`, { signal: AbortSignal.timeout(20_000) }).then((r) => r.json())
  const out: Claimable[] = []
  for (const c of Array.isArray(j) ? j : []) for (const r of c?.rewards ?? []) {
    const t = r?.token
    if (!t?.address || !Array.isArray(r.proofs)) continue
    const total = BigInt(r.amount ?? '0'), unclaimed = total - BigInt(r.claimed ?? '0')
    if (unclaimed <= 0n) continue
    const dec = Number(t.decimals ?? 18)
    out.push({ token: t.address, symbol: String(t.symbol ?? '?'), decimals: dec, total, unclaimed, usd: (Number(unclaimed) / 10 ** dec) * Number(t.price ?? 0), proofs: r.proofs })
  }
  return out
}

// Pure: is it worth claiming now? (One claim pays every token at once.)
export const worthClaiming = (items: { usd: number }[], minUsd: number) => items.reduce((a, i) => a + i.usd, 0) >= minUsd

export async function claimAll(c: ChainClients, items: Claimable[], send: (to: Address, data: Hex) => Promise<unknown>) {
  const me = c.account.address
  const data = encodeFunctionData({ abi: distAbi, functionName: 'claim', args: [items.map(() => me), items.map((i) => i.token), items.map((i) => i.total), items.map((i) => i.proofs)] })
  await send(DISTRIBUTOR, data)
}
