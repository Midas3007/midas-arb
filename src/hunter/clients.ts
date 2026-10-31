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

const cache = new Map<string, ChainClients>()
export function clientsFor(p: ChainProfile): ChainClients {
  const hit = cache.get(p.key)
  if (hit) return hit
  // JSON-RPC batching: many calls share one HTTP request.
  const transport = fallback(p.rpcs.map((u) => http(u, { timeout: 20_000, retryCount: 2, batch: { batchSize: 20, wait: 25 } })))
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
