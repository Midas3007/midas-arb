// LI.FI: a bridge and swap aggregator (no account or key). It picks the cheapest bridge between chains, and also
// does same-chain swaps (gas token <-> cash). Used by the treasury for deposits, gas top-ups, rebalancing and
// sweeps.
import { encodeFunctionData, erc20Abi, type Address } from 'viem'
import type { ChainClients } from './clients.js'

const LIFI = 'https://li.quest/v1'
export const NATIVE = '0x0000000000000000000000000000000000000000' as Address
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export type LifiQuote = { raw: any; outUsd: number; inUsd: number; feeUsd: number; tool: string; minutes: number }

export async function lifiQuote(from: ChainClients, to: ChainClients, fromToken: Address, toToken: Address, amount: bigint, toAddress: Address): Promise<LifiQuote> {
  const q = new URLSearchParams({
    fromChain: String(from.p.chain.id), toChain: String(to.p.chain.id), fromToken, toToken,
    fromAmount: amount.toString(), fromAddress: from.account.address, toAddress, slippage: '0.005',
  })
  const r = await fetch(`${LIFI}/quote?${q}`, { signal: AbortSignal.timeout(30_000) })
  const j: any = await r.json()
  if (!r.ok) throw new Error(j?.message ?? `LI.FI ${r.status}`)
  const inUsd = Number(j.estimate?.fromAmountUSD ?? 0), outUsd = Number(j.estimate?.toAmountUSD ?? 0)
  // Gas the source chain pays for the transaction counts as a cost too.
  const gasUsd = (j.estimate?.gasCosts ?? []).reduce((a: number, g: any) => a + Number(g.amountUSD ?? 0), 0)
  return { raw: j, inUsd, outUsd, feeUsd: Math.max(0, inUsd - outUsd) + gasUsd, tool: j.toolDetails?.name ?? j.tool, minutes: Math.round((j.estimate?.executionDuration ?? 0) / 60) }
}

// Sends the quoted transaction (approving the token first if needed) and waits until it has arrived.
// withLock wraps only the sending part (the source chain's wallet is busy), not the wait for arrival.
export async function lifiExecute(from: ChainClients, to: ChainClients, q: LifiQuote, fromToken: Address, amount: bigint, say: (s: string) => void,
  withLock: <T>(f: () => Promise<T>) => Promise<T> = (f) => f()): Promise<string> {
  const { pub, wallet, account } = from
  const hash = await withLock(async () => {
    if (fromToken !== NATIVE) {
      const spender = q.raw.estimate.approvalAddress as Address
      const allowance = await pub.readContract({ address: fromToken, abi: erc20Abi, functionName: 'allowance', args: [account.address, spender] })
      if (allowance < amount) {
        const approve = async (amt: bigint) => {
          const h = await wallet.sendTransaction({ account, chain: from.p.chain, to: fromToken, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amt] }) })
          await pub.waitForTransactionReceipt({ hash: h })
        }
        if (allowance > 0n) await approve(0n) // USDT-style tokens refuse a nonzero-to-nonzero change
        await approve(amount)
      }
    }
    const t = q.raw.transactionRequest
    const h = await wallet.sendTransaction({ account, chain: from.p.chain, to: t.to, data: t.data, value: BigInt(t.value ?? 0), ...(t.gasLimit ? { gas: BigInt(t.gasLimit) } : {}) })
    const rc = await pub.waitForTransactionReceipt({ hash: h, timeout: 180_000 })
    if (rc.status !== 'success') throw new Error(`transaction reverted: ${h}`)
    return h
  })
  if (from.p.key === to.p.key) return hash // same-chain swap: done
  say(`    sent ${hash}; waiting for it to arrive on ${to.p.key}...`)
  for (let i = 0; i < 90; i++) { // up to ~30 min
    await sleep(20_000)
    const s: any = await fetch(`${LIFI}/status?txHash=${hash}&fromChain=${from.p.chain.id}&toChain=${to.p.chain.id}`).then((r) => r.json()).catch(() => ({}))
    if (s.status === 'DONE') { say(`    arrived on ${to.p.key}`); return hash }
    if (s.status === 'FAILED') throw new Error(`bridge failed (${s.substatusMessage ?? 'see scan.li.fi'}): ${hash}`)
  }
  say(`    still in transit; check https://scan.li.fi/tx/${hash}`)
  return hash
}

// Dollar price of a token (LI.FI's price service); 0 when unknown.
export async function lifiPrice(chainId: number, token: Address): Promise<number> {
  const j: any = await fetch(`${LIFI}/token?chain=${chainId}&token=${token}`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.json()).catch(() => null)
  return Number(j?.priceUSD ?? 0)
}
