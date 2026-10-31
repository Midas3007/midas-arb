// The treasury: moves money between chains so it sits where it earns. One round, every TREASURY_MIN minutes
// while HUNTER_LIVE=1 (or by hand: npm run treasury / npm run withdraw):
//
// 1. Deposits: gas token sent to the wallet on any chain (ETH, BNB, POL, CELO...) beyond a small gas reserve is
//    swapped to that chain's cash token.
// 2. Gas: a chain that is short of gas buys GAS_TOPUP_USD ($1) of it from its own cash (same-chain swap), or,
//    with no cash there, gets it bridged from the richest chain.
// 3. Rebalance: cash is split between LIVE chains by what they earn per dollar (policy.allocate). Watch and paused
//    chains hand their cash to the live ones. Moves under SPLIT_MIN_MOVE_USD ($5) are skipped, and so is any
//    bridge costing more than SPLIT_MAX_FEE_PCT (2%). With no live chain yet, money stays where it is.
// 4. Sweep: when profit (from the ledger: trades after gas, minus fees; deposits never count) reaches
//    SWEEP_AT_USD, SWEEP_PCT of it goes to SWEEP_CHAIN in SWEEP_TOKEN, to SWEEP_TO (default: this wallet, kept
//    aside and never traded). See policy.planSweep.
//
// Every bridge and swap fee is booked in the ledger, so profit stays honest.
import 'dotenv/config'
import { encodeFunctionData, erc20Abi, formatUnits, parseUnits, type Address } from 'viem'
import { notify } from '../notify.js'
import { CHAINS, chainKeys, type ChainProfile } from './chains.js'
import { clientsFor, hunterAccount, type ChainClients } from './clients.js'
import { balances } from './desk.js'
import { lifiExecute, lifiPrice, lifiQuote, NATIVE } from './lifi.js'
import { localSwap } from './localswap.js'
import { allocate, planSweep, LIFECYCLE } from './policy.js'
import { Ledger, Locks, Store } from './store.js'

const n = (k: string, d: string) => Number(process.env[k] ?? d)
const MIN_MOVE_USD = n('SPLIT_MIN_MOVE_USD', '5')
const MAX_FEE_PCT = n('SPLIT_MAX_FEE_PCT', '2')
const GAS_TOPUP_USD = n('GAS_TOPUP_USD', '1')
const DEPOSIT_MIN_USD = n('DEPOSIT_MIN_USD', '2') // gas-token deposits smaller than this stay as gas
const errMsg = (e: any) => String(e?.shortMessage ?? e?.message ?? e).split('\n')[0]

export type TreasuryCtx = { store: Store; ledger: Ledger; locks: Locks; chains: ChainProfile[]; say?: (s: string) => void }
type Side = { c: ChainClients; p: ChainProfile; cashUsd: number; tradable: number; gasNative: bigint; gasOk: boolean; nativeUsd: number; cashDec: number }

const gasToken = (p: ChainProfile) => p.lifiNative ?? NATIVE

export async function treasuryRound(ctx: TreasuryCtx, opts: { go: boolean; forceSweep?: boolean }) {
  const say = ctx.say ?? ((s: string) => console.log(s))
  const { store, ledger, locks } = ctx
  const S = store.state
  const lock = (key: string) => <T>(f: () => Promise<T>) => locks.run(key, f)
  const me = hunterAccount().address

  // ---- balances ----
  const sides: Side[] = []
  for (const p of ctx.chains) {
    try {
      const b = await balances(p)
      const nativeUsd = p.native === 'USDT' ? 1 : await lifiPrice(p.chain.id, gasToken(p))
      sides.push({ c: clientsFor(p), p, cashUsd: b.cashUsd, tradable: Math.max(0, b.cashUsd - (S.reserved[p.key] ?? 0)), gasNative: b.gas, gasOk: b.gasOk, nativeUsd, cashDec: b.cashDecimals })
    } catch (e) { say(`  ${p.key}: balances unreadable (${errMsg(e)}); skipped this round`) }
  }
  const total = sides.reduce((a, s) => a + s.tradable, 0)
  say(`\n[treasury ${new Date().toISOString()}] wallet ${me}  tradable cash $${total.toFixed(2)}${opts.go ? '' : '  (plan only)'}`)
  for (const s of sides) {
    const gasUsd = Number(formatUnits(s.gasNative, 18)) * s.nativeUsd
    say(`  ${s.p.key.padEnd(10)} ${S.chains[s.p.key]?.mode.padEnd(6)} ${s.p.cashName} $${s.tradable.toFixed(2).padStart(8)}${S.reserved[s.p.key] ? ` (+$${S.reserved[s.p.key].toFixed(2)} set aside)` : ''}   gas $${gasUsd.toFixed(2)}${s.gasOk ? '' : ' (needs gas)'}`)
  }

  // A transfer through LI.FI: quote, fee check, send (under the source chain's lock), book the fee.
  // Same-chain swaps LI.FI cannot route (CELO on Celo) go straight through the chain's Uniswap instead.
  async function move(from: Side, toP: ChainProfile, fromToken: Address, toToken: Address, amount: bigint, usd: number, label: string, toAddress: Address = me, feeCheck = true) {
    const to = clientsFor(toP)
    let q
    try { q = await lifiQuote(from.c, to, fromToken, toToken, amount, toAddress) } catch (e) {
      if (from.p.key !== toP.key || toAddress !== me || fromToken === NATIVE || toToken === NATIVE) throw e
      const r = await lock(from.p.key)(() => localSwap(from.c, fromToken, toToken, amount, opts.go))
      say(`  ${label}: $${usd.toFixed(2)} on ${from.p.key} via ${from.p.dexes[0].name} (LI.FI has no route)${opts.go ? ` ${r.hash}` : ''}`)
      return opts.go ? { outUsd: usd, feeUsd: 0 } : null
    }
    say(`  ${label}: $${usd.toFixed(2)} ${from.p.key} -> ${toP.key} via ${q.tool}, arrives ~$${q.outUsd.toFixed(2)} (cost ~$${q.feeUsd.toFixed(2)}${from.p.key === toP.key ? '' : `, ~${q.minutes} min`})`)
    if (feeCheck && q.feeUsd > (usd * MAX_FEE_PCT) / 100) { say(`    skipped: costs more than ${MAX_FEE_PCT}% (SPLIT_MAX_FEE_PCT)`); return null }
    if (!opts.go) return null
    await lifiExecute(from.c, to, q, fromToken, amount, say, lock(from.p.key))
    if (q.feeUsd > 0) ledger.add({ chain: from.p.key, kind: 'fee', net: -q.feeUsd, note: label })
    return q
  }
  const cashUnits = (s: Side, usd: number) => parseUnits(usd.toFixed(Math.min(6, s.cashDec)), s.cashDec)

  // ---- 1. deposits of gas token -> cash ----
  for (const s of sides) {
    const gasUsd = Number(formatUnits(s.gasNative, 18)) * s.nativeUsd
    const excess = gasUsd - 2 * GAS_TOPUP_USD
    if (s.nativeUsd <= 0 || s.p.native === 'USDT' || excess < DEPOSIT_MIN_USD) continue
    const amount = parseUnits((excess / s.nativeUsd).toFixed(12), 18)
    try { if (await move(s, s.p, gasToken(s.p), s.p.tokens.USDT.address, amount, excess, `deposit: gas token -> ${s.p.cashName}`)) s.tradable += excess * 0.99 }
    catch (e) { say(`    deposit conversion failed: ${errMsg(e)}`) }
  }

  // ---- 2. gas top-ups ----
  for (const s of sides.filter((x) => !x.gasOk && (x.tradable > 0.5 || S.chains[x.p.key]?.mode === 'live'))) {
    try {
      if (s.tradable >= GAS_TOPUP_USD + 0.5) {
        if (await move(s, s.p, s.p.tokens.USDT.address, gasToken(s.p), cashUnits(s, GAS_TOPUP_USD), GAS_TOPUP_USD, 'gas top-up (own cash)', me, false)) s.tradable -= GAS_TOPUP_USD
      } else {
        const src = sides.filter((x) => x.gasOk && x !== s).sort((a, b) => b.tradable - a.tradable)[0]
        if (!src || src.tradable < GAS_TOPUP_USD + 1) { say(`  ${s.p.key} needs gas, but no chain with gas has spare cash to send it`); continue }
        if (await move(src, s.p, src.p.tokens.USDT.address, gasToken(s.p), cashUnits(src, GAS_TOPUP_USD), GAS_TOPUP_USD, 'gas top-up (bridged)', me, false)) src.tradable -= GAS_TOPUP_USD
      }
    } catch (e) { say(`    gas top-up failed: ${errMsg(e)}`) }
  }

  // ---- 3. rebalance toward live chains ----
  const now = Date.now(), window = now - LIFECYCLE.reviewDays * 86_400_000
  const targets = allocate(sides.map((s) => {
    const live = S.chains[s.p.key]?.mode === 'live'
    const hasHistory = ledger.trades(s.p.key, window) > 0
    return { key: s.p.key, live, roi: hasHistory ? ledger.since(s.p.key, window) / Math.max(s.tradable, 1) : null }
  }), total)
  if (!Object.keys(targets).length) say('  no live chain yet: cash stays where it is')
  else {
    say(`  targets: ${Object.entries(targets).map(([k, v]) => `${k} $${v.toFixed(2)}`).join(', ')}`)
    const tgt = (s: Side) => targets[s.p.key] ?? 0
    const over = sides.filter((s) => s.tradable - tgt(s) > MIN_MOVE_USD && s.gasOk).sort((a, b) => (b.tradable - tgt(b)) - (a.tradable - tgt(a)))
    const under = sides.filter((s) => tgt(s) - s.tradable > MIN_MOVE_USD).sort((a, b) => (tgt(b) - b.tradable) - (tgt(a) - a.tradable))
    if (!under.length) say(`  balanced (within $${MIN_MOVE_USD})`)
    for (const u of under) for (const o of over) {
      const amt = Math.floor(Math.min(tgt(u) - u.tradable, o.tradable - tgt(o)) * 100) / 100
      if (amt < MIN_MOVE_USD) continue
      try { if (await move(o, u.p, o.p.tokens.USDT.address, u.p.tokens.USDT.address, cashUnits(o, amt), amt, 'rebalance')) { o.tradable -= amt; u.tradable += amt } }
      catch (e) { say(`    rebalance failed: ${errMsg(e)}`) }
    }
  }

  // ---- 4. sweep profit to the withdrawal chain ----
  const plan = planSweep(sides.map((s) => ({ key: s.p.key, cum: ledger.cum(s.p.key), mark: S.marks[s.p.key] ?? 0 })), undefined, opts.forceSweep)
  const sweepKey = (process.env.SWEEP_CHAIN ?? 'bsc').toLowerCase()
  const dest = CHAINS[sweepKey]
  say(`  profit not yet swept: $${plan.newProfit.toFixed(4)}${plan.due ? '' : ` (sweeps at $${process.env.SWEEP_AT_USD ?? '20'})`}`)
  if (plan.due && !dest) say(`  SWEEP_CHAIN=${sweepKey} is not a known chain; nothing swept`)
  if (plan.due && dest) {
    const sweepTo = ((process.env.SWEEP_TO || me) as Address)
    const toToken = ((process.env.SWEEP_TOKEN || dest.tokens.USDT.address) as Address)
    const toCash = toToken.toLowerCase() === dest.tokens.USDT.address.toLowerCase()
    const keepHere = sweepTo.toLowerCase() === me.toLowerCase()
    if (plan.waiting.length) say(`  waiting (part under $${process.env.SWEEP_MIN_CHAIN_USD ?? '3'}): ${plan.waiting.join(', ')}`)
    for (const it of plan.items) {
      const s = sides.find((x) => x.p.key === it.key)!
      if (s.tradable < it.usd) { say(`  sweep ${it.key}: only $${s.tradable.toFixed(2)} cash there now; next round`); continue }
      try {
        let arrived = it.usd
        if (it.key === sweepKey && toCash) {
          if (!keepHere) {
            say(`  sweep ${it.key}: send $${it.usd.toFixed(2)} ${dest.cashName} to ${sweepTo}`)
            if (!opts.go) continue
            await lock(it.key)(async () => {
              const h = await s.c.wallet.sendTransaction({ account: s.c.account, chain: s.p.chain, to: s.p.tokens.USDT.address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [sweepTo, cashUnits(s, it.usd)] }) })
              await s.c.pub.waitForTransactionReceipt({ hash: h })
            })
          } else { say(`  sweep ${it.key}: set $${it.usd.toFixed(2)} aside on ${it.key} for withdrawal`); if (!opts.go) continue }
        } else {
          const q = await move(s, dest, s.p.tokens.USDT.address, toToken, cashUnits(s, it.usd), it.usd, `sweep ${it.key}`, sweepTo)
          if (!q) continue
          arrived = q.outUsd
        }
        if (keepHere && toCash) S.reserved[sweepKey] = (S.reserved[sweepKey] ?? 0) + arrived
        S.marks[it.key] = it.newMark
        S.sweptUsd += arrived
        store.save()
        s.tradable -= it.usd
        notify(`Swept $${arrived.toFixed(2)} of ${it.key} profit to ${sweepKey}${keepHere ? ' (kept aside in the bot wallet)' : ` -> ${sweepTo}`}. Total swept: $${S.sweptUsd.toFixed(2)}`)
      } catch (e) { say(`    sweep ${it.key} failed: ${errMsg(e)}`) }
    }
  }
  if (!opts.go) say('  (plan only: add --go to do it)')
}

// Releases money that was set aside for withdrawal after you have withdrawn it by hand (npm run withdraw -- --release 25).
export function release(store: Store, chain: string, usd: number) {
  store.state.reserved[chain] = Math.max(0, (store.state.reserved[chain] ?? 0) - usd)
  store.save()
}

// CLI: npm run treasury [-- --go]   |   npm run withdraw [-- --go]   |   npm run withdraw -- --release 25
const isMain = process.argv[1]?.endsWith('treasury.ts')
if (isMain) {
  const args = process.argv.slice(2)
  const keys = chainKeys().filter((k) => CHAINS[k])
  const store = new Store(keys), ledger = new Ledger(), locks = new Locks()
  const rel = args.indexOf('--release')
  if (rel >= 0) {
    const chain = (process.env.SWEEP_CHAIN ?? 'bsc').toLowerCase(), usd = Number(args[rel + 1] ?? '0')
    release(store, chain, usd)
    console.log(`released $${usd.toFixed(2)} on ${chain}; still set aside: $${(store.state.reserved[chain] ?? 0).toFixed(2)}`)
  } else {
    await treasuryRound({ store, ledger, locks, chains: keys.map((k) => CHAINS[k]) }, { go: args.includes('--go'), forceSweep: args.includes('--withdraw') })
  }
  process.exit(0)
}
