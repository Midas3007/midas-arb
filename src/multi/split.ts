// Spread the multi-chain wallet's cash evenly across chains, using LI.FI (a bridge aggregator: it picks the
// cheapest bridge, no account or key needed). Also tops up gas on chains that have none.
//
//   npm run multi-split                         show the plan only (moves nothing)
//   npm run multi-split -- --go                 do it
//   npm run multi-split -- --go --watch         keep checking every 10 min, so new deposits get spread out
//   npm run multi-split -- bsc base --go        only these chains
//
// Deposit cash (USDT on BSC/Polygon, USDC on Base/Sei, or whatever <CHAIN>_CASH says) plus a little gas
// on the chain you deposit to; that chain pays for the bridge transactions.
import 'dotenv/config'
import {
  createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, fallback, formatUnits, http, parseUnits,
  type Address, type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { CHAINS, type ChainProfile } from './chains.js'

const pk = process.env.MULTI_PRIVATE_KEY as Hex | undefined
if (!pk) throw new Error('Set MULTI_PRIVATE_KEY in .env')
const account = privateKeyToAccount(pk)
const args = process.argv.slice(2)
const GO = args.includes('--go'), WATCH = args.includes('--watch')
const chosen = args.filter((a) => !a.startsWith('--')).map((a) => a.toLowerCase())
const keys = (chosen.length ? chosen : (process.env.MULTI_CHAINS ?? 'bsc,polygon,base,sei,arbitrum').split(',')).map((s) => s.trim())
const MIN_MOVE_USD = Number(process.env.SPLIT_MIN_MOVE_USD ?? '5')   // smaller imbalances are left alone
const MAX_FEE_PCT = Number(process.env.SPLIT_MAX_FEE_PCT ?? '2')     // refuse a bridge that costs more than this
const GAS_TOPUP_USD = Number(process.env.SPLIT_GAS_TOPUP_USD ?? '1')  // gas sent to a chain that has none
// Below this much native gas a chain counts as empty (about $0.25-0.7 each).
const MIN_GAS: Record<string, string> = { bsc: '0.0005', polygon: '0.5', base: '0.0001', sei: '0.5', arbitrum: '0.0001' }
const NATIVE = '0x0000000000000000000000000000000000000000'
const LIFI = 'https://li.quest/v1'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const errMsg = (e: any) => String(e?.shortMessage ?? e?.message ?? e).split('\n')[0]

for (const k of keys) if (!CHAINS[k]) { console.error(`Unknown chain ${k}. Available: ${Object.keys(CHAINS).join(', ')}`); process.exit(1) }

type Side = { key: string; p: ChainProfile; cash: { address: Address; decimals: number }; pub: any; wallet: any }
function side(key: string): Side {
  const p = CHAINS[key]
  const transport = fallback(p.rpcs.map((u) => http(u, { timeout: 15_000, retryCount: 2 })))
  // The cash token, honouring <CHAIN>_CASH (e.g. SEI_CASH=USDC.n) like the desk does.
  const ck = process.env[`${key.toUpperCase()}_CASH`]
  const alt = ck ? p.tokens[ck] ?? (p.extras[ck] && { address: p.extras[ck].address, decimals: 6 }) : undefined
  return {
    key, p, cash: alt ?? p.tokens.USDT,
    pub: createPublicClient({ chain: p.chain, transport }),
    wallet: createWalletClient({ account, chain: p.chain, transport }),
  }
}
const sides = keys.map(side)

async function lifiQuote(from: Side, to: Side, toToken: string, amount: bigint) {
  const q = new URLSearchParams({
    fromChain: String(from.p.chain.id), toChain: String(to.p.chain.id), fromToken: from.cash.address, toToken,
    fromAmount: amount.toString(), fromAddress: account.address, toAddress: account.address, slippage: '0.005',
  })
  const r = await fetch(`${LIFI}/quote?${q}`, { signal: AbortSignal.timeout(30_000) })
  const j: any = await r.json()
  if (!r.ok) throw new Error(j?.message ?? `LI.FI ${r.status}`)
  return j
}

async function bridge(from: Side, to: Side, usd: number, toToken: string, label: string) {
  const amount = parseUnits(usd.toFixed(Math.min(6, from.cash.decimals)), from.cash.decimals)
  const q = await lifiQuote(from, to, toToken, amount)
  const outUsd = Number(q.estimate?.toAmountUSD ?? 0), feeUsd = usd - outUsd
  const tool = q.toolDetails?.name ?? q.tool
  console.log(`  ${label}: $${usd.toFixed(2)} ${from.key} -> ${to.key} via ${tool}, arrives ~$${outUsd.toFixed(2)} (cost ~$${feeUsd.toFixed(2)}, ~${Math.round((q.estimate?.executionDuration ?? 0) / 60)} min)`)
  if (toToken !== NATIVE && feeUsd > (usd * MAX_FEE_PCT) / 100) { console.log(`    skipped: costs more than ${MAX_FEE_PCT}% (SPLIT_MAX_FEE_PCT)`); return }
  if (!GO) return
  const spender = q.estimate.approvalAddress as Address
  const allowance = await from.pub.readContract({ address: from.cash.address, abi: erc20Abi, functionName: 'allowance', args: [account.address, spender] })
  if (allowance < amount) {
    if (allowance > 0n) await from.pub.waitForTransactionReceipt({ hash: await from.wallet.sendTransaction({ to: from.cash.address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, 0n] }) }) })
    await from.pub.waitForTransactionReceipt({ hash: await from.wallet.sendTransaction({ to: from.cash.address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }) }) })
  }
  const t = q.transactionRequest
  const hash = await from.wallet.sendTransaction({ to: t.to, data: t.data, value: BigInt(t.value ?? 0), ...(t.gasLimit ? { gas: BigInt(t.gasLimit) } : {}) })
  const rc = await from.pub.waitForTransactionReceipt({ hash, timeout: 180_000 })
  if (rc.status !== 'success') throw new Error(`bridge transaction reverted: ${hash}`)
  console.log(`    sent ${hash}; waiting for it to arrive on ${to.key}...`)
  for (let i = 0; i < 90; i++) { // up to ~30 min
    await sleep(20_000)
    const s: any = await fetch(`${LIFI}/status?txHash=${hash}&fromChain=${from.p.chain.id}&toChain=${to.p.chain.id}`).then((r) => r.json()).catch(() => ({}))
    if (s.status === 'DONE') { console.log(`    arrived on ${to.key}`); return }
    if (s.status === 'FAILED') throw new Error(`bridge failed (${s.substatusMessage ?? 'see li.fi scan'}): ${hash}`)
  }
  console.log(`    still in transit; check https://scan.li.fi/tx/${hash}`)
}

let decimalsRead = false
async function round() {
  if (!decimalsRead) { // read each cash token's decimals on-chain rather than trusting the profile
    for (const s of sides) s.cash = { ...s.cash, decimals: Number(await s.pub.readContract({ address: s.cash.address, abi: erc20Abi, functionName: 'decimals' })) }
    decimalsRead = true
  }
  const bal = await Promise.all(sides.map(async (s) => {
    const [c, g] = await Promise.all([
      s.pub.readContract({ address: s.cash.address, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }),
      s.pub.getBalance({ address: account.address }),
    ])
    const gasOk = g >= parseUnits(MIN_GAS[s.key] ?? '0', 18)
    return { s, usd: Number(formatUnits(c, s.cash.decimals)), gas: Number(formatUnits(g, 18)), gasOk }
  }))
  const total = bal.reduce((a, b) => a + b.usd, 0)
  const target = total / bal.length
  console.log(`\n[${new Date().toISOString()}] wallet ${account.address}  total $${total.toFixed(2)}, target $${target.toFixed(2)} per chain`)
  for (const b of bal) console.log(`  ${b.s.key.padEnd(8)} cash $${b.usd.toFixed(2).padStart(8)}   gas ${b.gas.toFixed(5)}${b.gasOk ? '' : '  (needs gas)'}`)

  // Gas first: a chain with no gas cannot trade (or send its own bridge transactions later).
  const richest = () => [...bal].filter((b) => b.gasOk).sort((a, b) => b.usd - a.usd)[0]
  for (const b of bal.filter((x) => !x.gasOk)) {
    const src = richest()
    if (!src || src.usd < GAS_TOPUP_USD + 1) { console.log(`  ${b.s.key} needs gas, but no chain with gas has spare cash to send it`); continue }
    try { await bridge(src.s, b.s, GAS_TOPUP_USD, NATIVE, 'gas top-up'); src.usd -= GAS_TOPUP_USD } catch (e) { console.log(`    gas top-up failed: ${errMsg(e)}`) }
  }

  // Then cash: move from chains above the target to chains below it, biggest gaps first.
  const over = bal.filter((b) => b.usd - target > MIN_MOVE_USD && b.gasOk).sort((a, b) => b.usd - a.usd)
  const under = bal.filter((b) => target - b.usd > MIN_MOVE_USD).sort((a, b) => a.usd - b.usd)
  if (!under.length) { console.log('  balanced (within $' + MIN_MOVE_USD + '); nothing to move'); return }
  for (const u of under) for (const o of over) {
    const need = target - u.usd, spare = o.usd - target
    const amt = Math.floor(Math.min(need, spare) * 100) / 100
    if (amt < MIN_MOVE_USD) continue
    try { await bridge(o.s, u.s, amt, u.s.cash.address, 'move'); o.usd -= amt; u.usd += amt } catch (e) { console.log(`    failed: ${errMsg(e)}`) }
  }
  if (!GO) console.log('  (plan only: add --go to do it)')
}

do {
  try { await round() } catch (e) { console.log(`error: ${errMsg(e)}`) }
  if (WATCH) await sleep(10 * 60_000)
} while (WATCH)
