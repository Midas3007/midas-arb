// One wallet (HUNTER_PRIVATE_KEY) on every chain, with one RPC connection per chain shared by the desk and the
// treasury.
import 'dotenv/config'
import { cheapFees } from '../fees.js'
import { createPublicClient, createWalletClient, fallback, http, toHex, type Address, type Hex, type PrivateKeyAccount, type PublicClient, type Transport, type WalletClient } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { ChainProfile } from './chains.js'

export type ChainClients = { p: ChainProfile; pub: PublicClient; wallet: WalletClient; account: PrivateKeyAccount }

let acct: PrivateKeyAccount | null = null
export function hunterAccount(): PrivateKeyAccount {
  if (acct) return acct
  let pk = process.env.HUNTER_PRIVATE_KEY as Hex | undefined
  if (!pk) {
    if (process.env.HUNTER_LIVE === '1') throw new Error('Set HUNTER_PRIVATE_KEY in .env (make a new wallet with: npm run new-wallet)')
    // Watching only: a throwaway address is enough to read prices (it holds nothing and never sends).
    pk = generatePrivateKey()
    console.log('No HUNTER_PRIVATE_KEY yet: watching with a throwaway address (nothing can be traded or moved).')
  }
  // Peg Hunter must never share a wallet with Kiyoshi or the fund.
  for (const other of ['AGENT_PRIVATE_KEY', 'KIYOSHI_PRIVATE_KEY', 'FUND_PRIVATE_KEY'])
    if (process.env[other] && process.env[other]!.toLowerCase() === pk.toLowerCase()) throw new Error(`HUNTER_PRIVATE_KEY must be a different wallet from ${other}.`)
  acct = privateKeyToAccount(pk)
  return acct
}

// RPC addresses that don't answer at startup (down, or out of credits like a used-up QuickNode trial) move to the
// back of the list instead of being dropped: the working ones are used first, and the connection keeps re-checking
// all of them every minute (see clientsFor), so one that comes back is used again.
export async function pruneRpcs(p: ChainProfile, say: (s: string) => void = console.log): Promise<void> {
  const ok: string[] = []
  await Promise.all(p.rpcs.map(async (u) => {
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }), signal: AbortSignal.timeout(10_000) })
      const j: any = await r.json()
      if (r.ok && typeof j?.result === 'string') ok.push(u)
      else say(`[${p.key}] RPC not answering for now, tried last and re-checked every minute (${j?.error?.message ?? `HTTP ${r.status}`}): ${u.replace(/\/[A-Za-z0-9]{16,}\/?$/, '/…')}`)
    } catch (e: any) { say(`[${p.key}] RPC not answering for now, tried last and re-checked every minute (${String(e?.message ?? e).split('\n')[0]}): ${u.replace(/\/[A-Za-z0-9]{16,}\/?$/, '/…')}`) }
  }))
  p.rpcs = [...p.rpcs.filter((u) => ok.includes(u)), ...p.rpcs.filter((u) => !ok.includes(u))] // working first, .env order kept
}

// Honest quotes. Some pools are traps for bots: their price oracle answers one way when a call carries no gas price
// (how quotes and simulations are normally made) and another way inside a real transaction. On Base, Curve's
// "USDPOOL" (0x335BE1a3...) showed a 0.4% gap that way: every quote and simulation passed, every real sale reverted.
// So every eth_call here carries the network's gas price (doubled, so it is never under the base fee) and comes from
// our own address, which is given a balance for the call only (quotes work with an empty wallet, and big multicall
// batches are not cut short). A trap then shows its real price, and its fake gap disappears. If an RPC refuses
// these extra fields, plain calls are used on that chain (said once).
const SIM_BALANCE = toHex(10n ** 24n)
const SIM_GAS = toHex(15_000_000n) // a gas limit must be given (some nodes default to an absurd one); under Gnosis's 17M block
function honestCalls(t: Transport, me: Address, key: string): Transport {
  return ((params: any) => {
    const inner = t(params)
    let gp = 0n, gpAt = 0, off = false
    const price = async () => {
      if (Date.now() - gpAt > 30_000) {
        gpAt = Date.now()
        try { gp = BigInt((await inner.request({ method: 'eth_gasPrice' })) as string) } catch { /* keep the last one */ }
      }
      return gp
    }
    const request = async (args: any, opts?: any) => {
      if (off || args?.method !== 'eth_call') return inner.request(args, opts)
      const [tx, block, overrides] = args.params ?? []
      if (!tx || tx.gasPrice || tx.maxFeePerGas) return inner.request(args, opts)
      const g = await price()
      if (g <= 0n) return inner.request(args, opts)
      const from = (tx.from ?? me) as string
      const ov = { ...(overrides ?? {}) }
      const k = Object.keys(ov).find((a) => a.toLowerCase() === from.toLowerCase()) ?? from
      if (ov[k]?.balance === undefined) ov[k] = { ...(ov[k] ?? {}), balance: SIM_BALANCE }
      try {
        return await inner.request({ ...args, params: [{ ...tx, from, gas: tx.gas ?? SIM_GAS, gasPrice: toHex(g * 2n) }, block ?? 'latest', ov] }, opts)
      } catch (e: any) {
        const m = `${e?.details ?? ''} ${e?.message ?? ''}`
        if (/revert/i.test(m) || !/override|not supported|unsupported|invalid argument|unknown field|cannot unmarshal|insufficient funds|-32602/i.test(m)) throw e
        off = true
        console.log(`[${key}] this RPC refuses priced calls; quotes on ${key} use plain calls (trap pools are not filtered here)`)
        return inner.request(args, opts)
      }
    }
    return { ...inner, request }
  }) as Transport
}

const cache = new Map<string, ChainClients>()
export function clientsFor(p: ChainProfile): ChainClients {
  const hit = cache.get(p.key)
  if (hit) return hit
  // JSON-RPC batching: many calls share one HTTP request.
  // fallback: if one RPC fails a call, the next one is tried; rank: every minute each RPC is pinged and the list is
  // re-ordered by how fast and reliably it answers, so a dead one drops back and a recovered one returns.
  const account = hunterAccount()
  const transport = honestCalls(fallback(p.rpcs.map((u) => http(u, { timeout: 20_000, retryCount: 2, batch: { batchSize: 20, wait: 25 } })), p.rpcs.length > 1 ? { rank: { interval: 60_000, sampleCount: 5, timeout: 10_000 } } : {}), account.address, p.key)
  const c: ChainClients = {
    p,
    pub: createPublicClient({ chain: p.chain, transport, batch: { multicall: true } }) as PublicClient,
    wallet: createWalletClient({ account, chain: p.chain, transport }),
    account,
  }
  cache.set(p.key, c)
  return c
}

// Send one transaction for the treasury: simulated first (a revert costs nothing), cheap fees, wait for success.
export async function sendTx(c: ChainClients, to: Address, data: Hex) {
  await c.pub.call({ account: c.account, to, data })
  const fees = await cheapFees(c.pub, { account: c.account.address, to, data }).catch(() => ({}))
  const hash = await c.wallet.sendTransaction({ account: c.account, chain: c.p.chain, to, data, ...fees } as any)
  const r = await c.pub.waitForTransactionReceipt({ hash, timeout: 120_000 })
  if (r.status !== 'success') throw new Error(`transaction reverted: ${hash}`)
  return r
}
