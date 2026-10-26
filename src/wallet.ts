import { createPublicClient, createWalletClient, concat, fallback, http, type Address, type Hex, type TransactionReceipt } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { celo } from 'viem/chains'
import { toDataSuffix } from '@celo/attribution-tags'
import { ATTRIBUTION_TAG, RPC_URL } from './config.js'

const pk = process.env.AGENT_PRIVATE_KEY as Hex | undefined
if (!pk) throw new Error('Set AGENT_PRIVATE_KEY in .env (run: npm run new-wallet)')

export const account = privateKeyToAccount(pk)
// CELO_RPCS=url1,url2 adds backup RPCs; requests fail over if one is down or rate-limited.
const rpcs = [RPC_URL, ...(process.env.CELO_RPCS ?? '').split(',').map((s) => s.trim()).filter(Boolean)]
const transport = fallback(rpcs.map((url) => http(url, { timeout: 15_000, retryCount: 2 })))
export const pub = createPublicClient({ chain: celo, transport, batch: { multicall: true } })
const wallet = createWalletClient({ account, chain: celo, transport })

export const TAG_SUFFIX = (ATTRIBUTION_TAG ? toDataSuffix(ATTRIBUTION_TAG) : '0x') as Hex

// Block of the agent's most recent transaction. Reads must not come from a node behind this.
export let lastTxBlock = 0n

// The ONLY way the agent sends transactions, so nothing ever goes out untagged.
export async function sendTaggedReceipt(tx: { to: Address; data?: Hex; value?: bigint }): Promise<TransactionReceipt> {
  const data = concat([tx.data ?? '0x', TAG_SUFFIX])
  // Simulate first: a call that would revert throws here (with its reason) instead of costing gas on-chain.
  await pub.call({ account, to: tx.to, data, value: tx.value ?? 0n })
  const hash = await wallet.sendTransaction({ to: tx.to, data, value: tx.value ?? 0n })
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 })
  if (receipt.status !== 'success') throw new Error(`Transaction reverted: ${hash}`)
  if (receipt.blockNumber > lastTxBlock) lastTxBlock = receipt.blockNumber
  return receipt
}

export async function sendTagged(tx: { to: Address; data?: Hex; value?: bigint }): Promise<Hex> {
  return (await sendTaggedReceipt(tx)).transactionHash
}
