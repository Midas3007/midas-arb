// /switch <chain> on Telegram: move everything to one chain and trade only there.
//
// 1. The target chain goes live (set by hand) and every other chain that holds money or is live is switched off,
//    so nothing trades while money moves (a chain that is off does nothing; see desk.ts).
// 2. From every other chain: cash parked in Aave comes out, all of the cash token is bridged to the target's cash
//    token, then all of the gas token (less the gas of that very transaction) to the target's gas token. If the
//    gas token cannot be bridged and the target has no gas yet, $1 of the cash goes to the target's gas token
//    instead, so the target can trade at once.
// 3. Every bridge goes through LI.FI (cheapest route, quoted first), and its cost is booked as a fee.
//
// Money set aside for withdrawal (SWEEP_TO empty) stays where it is. Leftover coins from a half-finished trade are
// sold on their own chain by the loss guard; run /switch again afterwards to bring that cash over too.
import { erc20Abi, formatUnits, parseUnits, type Address } from 'viem'
import { existsSync, readFileSync } from 'node:fs'
import { DATA_DIR } from '../config.js'
import { CHAINS, type ChainProfile } from './chains.js'
import { clientsFor, hunterAccount, sendTx, type ChainClients } from './clients.js'
import { lifiExecute, lifiPrice, lifiQuote, NATIVE, type LifiQuote } from './lifi.js'
import { inflight } from './inflight.js'
import { aaveInfo, aaveWithdraw, parkedUnits } from './savings.js'
import { freshState } from './policy.js'
import type { Ledger, Locks, Store } from './store.js'

const MIN_CASH_USD = 0.5 // smaller cash is dust: not worth a bridge
const MIN_GAS_USD = 0.3 // gas token worth less than this (after keeping the gas to send it) stays
const GAS_FOR_TARGET_USD = Number(process.env.GAS_TOPUP_USD ?? '1')
const errMsg = (e: any) => String(e?.shortMessage ?? e?.message ?? e).split('\n')[0]
const gasToken = (p: ChainProfile) => p.lifiNative ?? NATIVE
const gasName = (p: ChainProfile) => p.chain.nativeCurrency.symbol // ETH, CELO, BNB, POL...

let busy = false
export const switching = () => busy // the treasury skips its rounds while a switch runs

export type SwitchCtx = { store: Store; ledger: Ledger; locks: Locks; chains: ChainProfile[] }

type Source = { p: ChainProfile; c: ChainClients; cash: bigint; cashUsd: number; parked: bigint; gas: bigint; nativeUsd: number; reservedUsd: number; leftovers: string[] }

async function readSource(p: ChainProfile, reservedUsd: number): Promise<Source> {
  const c = clientsFor(p)
  const [cash, gas, sav] = await Promise.all([
    c.pub.readContract({ address: p.tokens.USDT.address, abi: erc20Abi, functionName: 'balanceOf', args: [c.account.address] }),
    c.pub.getBalance({ address: c.account.address }),
    aaveInfo(c).catch(() => null),
  ])
  const parked = sav ? await parkedUnits(c).catch(() => 0n) : 0n
  const nativeUsd = p.native === 'USDT' ? 1 : await lifiPrice(p.chain.id, gasToken(p))
  const dec = p.tokens.USDT.decimals
  const lotsFile = `${DATA_DIR}/${p.key}/pending.json`
  const leftovers = existsSync(lotsFile) ? Object.keys(JSON.parse(readFileSync(lotsFile, 'utf8') || '{}')) : []
  return { p, c, cash, cashUsd: Number(formatUnits(cash + parked, dec)), parked, gas, nativeUsd, reservedUsd, leftovers }
}

// The gas token to send: everything but the gas of the bridge transaction itself (its gas limit at twice the
// current fee, which also covers the L1 data fee on Base and Optimism).
// It goes to the target's gas token, or, when no bridge offers that, to the target's cash token (so it is not left behind).
async function gasPlan(s: Source, to: ChainClients, toTokens: Address[]) {
  const me = s.c.account.address
  const fees = await s.c.pub.estimateFeesPerGas().catch(async () => ({ gasPrice: await s.c.pub.getGasPrice() } as any))
  const perGas: bigint = fees.maxFeePerGas ?? fees.gasPrice
  let probe: LifiQuote | null = null, toToken = toTokens[0], last: unknown
  for (const t of toTokens) {
    try { probe = await lifiQuote(s.c, to, gasToken(s.p), t, (s.gas * 8n) / 10n, me); toToken = t; break } catch (e) { last = e }
  }
  if (!probe) throw last
  const limit = BigInt(probe.raw.transactionRequest?.gasLimit ?? 1_500_000)
  const keep = limit * perGas * 2n
  const amount = s.gas - keep
  const usd = Number(formatUnits(amount > 0n ? amount : 0n, 18)) * s.nativeUsd
  if (amount <= 0n || usd < MIN_GAS_USD) return { amount: 0n, usd, keepUsd: Number(formatUnits(s.gas, 18)) * s.nativeUsd, q: null as LifiQuote | null, fees, toToken }
  const q = await lifiQuote(s.c, to, gasToken(s.p), toToken, amount, me)
  return { amount, usd, keepUsd: Number(formatUnits(keep, 18)) * s.nativeUsd, q, fees, toToken }
}

export async function switchTo(ctx: SwitchCtx, target: string, opts: { go: boolean; say: (s: string) => void }) {
  const { say } = opts
  const T = CHAINS[target]
  if (!T || !ctx.chains.some((p) => p.key === target)) throw new Error(`unknown chain ${target}`)
  if (busy) throw new Error('a switch is already running')
  busy = opts.go
  try {
    const S = ctx.store.state
    const me = hunterAccount().address
    const to = clientsFor(T)
    const dest = await readSource(T, 0)
    const sources: Source[] = []
    for (const p of ctx.chains.filter((x) => x.key !== target)) {
      try {
        const s = await readSource(p, S.reserved[p.key] ?? 0)
        if (s.cashUsd - s.reservedUsd >= MIN_CASH_USD || Number(formatUnits(s.gas, 18)) * s.nativeUsd >= MIN_GAS_USD) sources.push(s)
      } catch (e) { say(`${p.key}: balances unreadable (${errMsg(e)}); skipped`) }
    }
    const lines: string[] = [`Switch to ${target}${opts.go ? '' : ' (plan)'}:`]
    const destGasUsd = Number(formatUnits(dest.gas, 18)) * dest.nativeUsd
    lines.push(`${target} has now: ${T.cashName} $${dest.cashUsd.toFixed(2)}, gas $${destGasUsd.toFixed(2)}`)
    const destHasGas = dest.gas >= parseUnits(T.minGas, 18)
    let gasArranged = destHasGas

    // Plan: quote everything before moving anything.
    type Move = { s: Source; kind: 'cash' | 'gas' | 'cash->gas'; amount: bigint; usd: number; q: LifiQuote; fromToken: Address; fees?: any; note?: string }
    const moves: Move[] = []
    for (const s of sources) {
      const spendable = s.cash + s.parked - parseUnits(s.reservedUsd.toFixed(Math.min(6, s.p.tokens.USDT.decimals)), s.p.tokens.USDT.decimals)
      const spendUsd = Number(formatUnits(spendable > 0n ? spendable : 0n, s.p.tokens.USDT.decimals))
      // gas token first in the plan (it decides whether the target needs some of the cash as gas)
      let g: Awaited<ReturnType<typeof gasPlan>> | null = null
      const gasUsdHere = Number(formatUnits(s.gas, 18)) * s.nativeUsd
      if (gasUsdHere >= MIN_GAS_USD) {
        try { g = await gasPlan(s, to, [gasToken(T), T.tokens.USDT.address]) } catch (e) { lines.push(`${s.p.key}: its ${gasName(s.p)} ($${gasUsdHere.toFixed(2)}) cannot be bridged to ${target} right now (${errMsg(e)}); it stays on ${s.p.key}`) }
      }
      if (g?.q && g.toToken === gasToken(T)) gasArranged = true
      let cashAmount = spendable, cashUsd = spendUsd
      if (!gasArranged && spendUsd >= GAS_FOR_TARGET_USD + MIN_CASH_USD) {
        const part = parseUnits(GAS_FOR_TARGET_USD.toFixed(2), s.p.tokens.USDT.decimals)
        try {
          const q = await lifiQuote(s.c, to, s.p.tokens.USDT.address, gasToken(T), part, me)
          moves.push({ s, kind: 'cash->gas', amount: part, usd: GAS_FOR_TARGET_USD, q, fromToken: s.p.tokens.USDT.address })
          cashAmount -= part; cashUsd -= GAS_FOR_TARGET_USD; gasArranged = true
        } catch (e) { lines.push(`${s.p.key}: cannot buy ${target} gas with ${s.p.cashName} (${errMsg(e)})`) }
      }
      if (cashUsd >= MIN_CASH_USD) {
        try { moves.push({ s, kind: 'cash', amount: cashAmount, usd: cashUsd, q: await lifiQuote(s.c, to, s.p.tokens.USDT.address, T.tokens.USDT.address, cashAmount, me), fromToken: s.p.tokens.USDT.address }) }
        catch (e) { lines.push(`${s.p.key}: no route for ${s.p.cashName} -> ${target} ${T.cashName} (${errMsg(e)}); it stays`) }
      }
      if (g?.q) moves.push({ s, kind: 'gas', amount: g.amount, usd: g.usd, q: g.q, fromToken: gasToken(s.p), fees: g.fees, note: `${g.toToken === gasToken(T) ? '' : `arrives as ${T.cashName} (no bridge offers ${gasName(T)} right now); `}keeps ~$${g.keepUsd.toFixed(2)} to pay for sending it` })
      else if (g) lines.push(`${s.p.key}: gas token worth $${g.keepUsd.toFixed(2)} stays (too little to be worth bridging)`)
      if (s.reservedUsd > 0) lines.push(`${s.p.key}: $${s.reservedUsd.toFixed(2)} set aside for withdrawal stays there`)
      if (s.leftovers.length) lines.push(`${s.p.key}: still holds ${s.leftovers.join(', ')} from a half-finished trade; it is sold there, then /switch ${target} again brings it over`)
    }
    for (const m of moves) {
      const what = m.kind === 'gas' ? `gas ${gasName(m.s.p)}` : m.kind === 'cash->gas' ? `${m.s.p.cashName} -> ${target} gas` : `${m.s.p.cashName}`
      lines.push(`• ${m.s.p.key}: ${what} $${m.usd.toFixed(2)} -> ~$${m.q.outUsd.toFixed(2)} on ${target} via ${m.q.tool} (cost ~$${m.q.feeUsd.toFixed(2)}, ~${Math.max(1, m.q.minutes)} min)${m.s.parked > 0n && m.kind === 'cash' ? ', Aave cash taken out first' : ''}${m.note ? `; ${m.note}` : ''}`)
    }
    if (!moves.length) lines.push(sources.length ? 'Nothing can be moved right now.' : `Nothing to move: the money is already on ${target}.`)
    if (!gasArranged) lines.push(`Warning: ${target} has no gas and none can be sent; send a little ${gasName(T)} to the wallet on ${target}.`)
    const offs = ctx.chains.filter((p) => p.key !== target && (S.chains[p.key]?.mode === 'live' || sources.some((s) => s.p.key === p.key))).map((p) => p.key)
    lines.push(`Then: ${target} live${offs.length ? `; off: ${offs.join(', ')}` : ''}.`)
    if (!opts.go) return lines.join('\n')

    // Go: modes first (nothing trades while money moves), then the moves, one chain at a time.
    S.chains[target] = { ...freshState('live', Date.now(), 'switched here with /switch'), manual: true }
    for (const k of offs) S.chains[k] = { ...freshState('paused', Date.now(), `switched off by /switch ${target}`), manual: true }
    ctx.store.save()
    say(`${target} is live; ${offs.length ? `${offs.join(', ')} off` : 'no other chain was on'}. Moving ${moves.length} item(s)...`)
    const lock = (key: string) => <T>(f: () => Promise<T>) => ctx.locks.run(key, () => inflight.run(f))
    let arrived = 0, failed = 0
    for (const m of moves) {
      const label = `${m.s.p.key} ${m.kind === 'gas' ? 'gas' : m.kind === 'cash->gas' ? `cash -> ${target} gas` : 'cash'}`
      try {
        if (m.kind !== 'gas' && m.s.parked > 0n) {
          say(`${m.s.p.key}: taking cash out of Aave`)
          await lock(m.s.p.key)(() => aaveWithdraw(m.s.c, 2n ** 256n - 1n, (t, d) => sendTx(m.s.c, t, d)))
          m.s.parked = 0n
          ctx.store.state.parked[m.s.p.key] = 0; ctx.store.save()
        }
        // Re-quote just before sending (quotes expire); the gas token is re-read so the amount is exact.
        let { amount, q } = m
        if (m.kind === 'gas') {
          const fresh = await readSource(m.s.p, m.s.reservedUsd)
          const g = await gasPlan(fresh, to, [gasToken(T), T.tokens.USDT.address])
          if (!g.q) { say(`${label}: too little left to bridge; stays`); continue }
          amount = g.amount; q = g.q; m.fees = g.fees
        } else {
          if (m.kind === 'cash') { // everything there is now (the loss guard or a treasury round may have changed it)
            const now = await readSource(m.s.p, m.s.reservedUsd)
            const dec = m.s.p.tokens.USDT.decimals
            const all = now.cash - parseUnits(Math.max(0, m.s.reservedUsd).toFixed(Math.min(6, dec)), dec)
            if (all <= 0n) { say(`${label}: nothing left to send`); continue }
            amount = all
          }
          q = await lifiQuote(m.s.c, to, m.fromToken, m.kind === 'cash' ? T.tokens.USDT.address : gasToken(T), amount, me)
        }
        say(`${label}: sending $${m.usd.toFixed(2)} via ${q.tool}, arrives ~$${q.outUsd.toFixed(2)}`)
        const fees = m.kind === 'gas' && m.fees ? (m.fees.maxFeePerGas ? { maxFeePerGas: m.fees.maxFeePerGas, maxPriorityFeePerGas: m.fees.maxPriorityFeePerGas } : { gasPrice: m.fees.gasPrice }) : {}
        await lifiExecute(m.s.c, to, q, m.fromToken, amount, say, lock(m.s.p.key), fees)
        if (q.feeUsd > 0) ctx.ledger.add({ chain: m.s.p.key, kind: 'fee', net: -q.feeUsd, note: `/switch ${target}: ${label}` })
        arrived += q.outUsd
      } catch (e) { failed++; say(`${label} failed: ${errMsg(e)}`) }
    }
    const after = await readSource(T, 0).catch(() => null)
    say(`Done${failed ? ` (${failed} failed: see above; /switch ${target} again retries)` : ''}. ${target} now has ${T.cashName} $${after?.cashUsd.toFixed(2) ?? '?'} and gas $${after ? (Number(formatUnits(after.gas, 18)) * after.nativeUsd).toFixed(2) : '?'}${after && after.gas < parseUnits(T.minGas, 18) ? ' (not enough gas yet: it may still be arriving)' : ''}.`)
    return lines.join('\n')
  } finally { busy = false }
}

// Gaps each chain recorded in the last 24 hours (from its opps.jsonl), to help pick where to switch.
export function recentGaps(keys: string[], hours = 24): Record<string, { count: number; bestPct: number }> {
  const since = Date.now() - hours * 3_600_000, out: Record<string, { count: number; bestPct: number }> = {}
  for (const k of keys) {
    const f = `${DATA_DIR}/${k}/opps.jsonl`
    const seen = new Set<string>()
    let bestPct = 0
    if (existsSync(f)) for (const l of readFileSync(f, 'utf8').split('\n')) {
      try {
        const o = JSON.parse(l)
        if (!o.ts || Date.parse(o.ts) < since || !(o.net > 0)) continue
        seen.add(`${o.route}:${Math.floor(Date.parse(o.ts) / 600_000)}`) // one gap per route per 10 minutes
        bestPct = Math.max(bestPct, o.gapPct ?? 0)
      } catch { /* partial line */ }
    }
    out[k] = { count: seen.size, bestPct }
  }
  return out
}
