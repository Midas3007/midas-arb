// Cheap but reliable gas. On EIP-1559 chains a transaction pays the block's base fee plus its tip; the max fee
// is only a ceiling. So the tip is the network's suggested one (the cheapest that still gets included quickly)
// and the ceiling is generous (2x base fee) so a sudden base-fee rise cannot leave the transaction stuck.
// Chains without a base fee (BSC) use the node's current gas price, which is already the minimum accepted.
// The gas limit is the node's estimate plus 25%.
import type { Address, Hex, PublicClient } from 'viem'

export async function cheapFees(pub: PublicClient, tx: { account: Address; to: Address; data: Hex; value?: bigint }) {
  const [block, gasEstimate] = await Promise.all([
    pub.getBlock({ blockTag: 'latest' }),
    pub.estimateGas({ account: tx.account, to: tx.to, data: tx.data, value: tx.value ?? 0n }),
  ])
  const gas = (gasEstimate * 125n) / 100n
  const base = block.baseFeePerGas
  if (base === null || base === undefined || base === 0n) return { gas, gasPrice: await pub.getGasPrice() }
  const tip = await pub.estimateMaxPriorityFeePerGas().catch(() => 0n)
  return { gas, maxFeePerGas: base * 2n + tip, maxPriorityFeePerGas: tip }
}
