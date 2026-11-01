// One wallet (HUNTER_PRIVATE_KEY) on every chain, with one RPC connection per chain shared by the desk and the
// treasury.
import 'dotenv/config'
import { cheapFees } from '../fees.js'
import { createPublicClient, createWalletClient, fallback, http, type Address, type Hex, type PrivateKeyAccount, type PublicClient, type WalletClient } from 'viem'
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

const cache = new Map<string, ChainClients>()
export function clientsFor(p: ChainProfile): ChainClients {
  const hit = cache.get(p.key)
  if (hit) return hit
  // JSON-RPC batching: many calls share one HTTP request.
  // fallback: if one RPC fails a call, the next one is tried; rank: every minute each RPC is pinged and the list is
  // re-ordered by how fast and reliably it answers, so a dead one drops back and a recovered one returns.
  const transport = fallback(p.rpcs.map((u) => http(u, { timeout: 20_000, retryCount: 2, batch: { batchSize: 20, wait: 25 } })), p.rpcs.length > 1 ? { rank: { interval: 60_000, sampleCount: 5, timeout: 10_000 } } : {})
  const account = hunterAccount()
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
