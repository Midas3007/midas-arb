// Peg Hunter: npm start (all chains in HUNTER_CHAINS, default all), or npm start -- base celo
//
// Runs in one process: a desk per chain, the fair-price feed, the chain lifecycle (watch -> live -> paused), the
// treasury (deposits, gas, rebalancing, sweeps; only with HUNTER_LIVE=1) and Telegram commands.
import 'dotenv/config'
import { notify } from '../notify.js'
import { CHAINS, chainKeys } from './chains.js'
import { hunterAccount } from './clients.js'
import { runChain, type Ctx } from './desk.js'
import { FairPrices } from './fair.js'
import { PegBoard } from './peg.js'
import { LIFECYCLE, nextState } from './policy.js'
import { Ledger, Locks, Store } from './store.js'
import { telegramLoop } from './telegram.js'
import { treasuryRound } from './treasury.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const wanted = process.argv.slice(2).filter((a) => !a.startsWith('--')).map((s) => s.toLowerCase())
const keys = wanted.length ? wanted : chainKeys()
const unknown = keys.filter((k) => !CHAINS[k])
if (unknown.length) { console.error(`Unknown chain(s): ${unknown.join(', ')}. Available: ${Object.keys(CHAINS).join(', ')}`); process.exit(1) }

const live = process.env.HUNTER_LIVE === '1'
hunterAccount() // fails early when HUNTER_LIVE=1 and no key is set
let stopping = false
const ctx: Ctx = {
  store: new Store(keys),
  ledger: new Ledger(),
  fair: new FairPrices(),
  board: new PegBoard(undefined, (msg) => { console.log(msg); notify(`Peg Hunter: ${msg}`) }),
  locks: new Locks(),
  live,
  status: new Map(),
  stopping: () => stopping,
  busy: { n: 0 },
}

// Fair prices first (the desks need them), then keep them fresh.
await ctx.fair.refresh()
for (const e of ctx.fair.errors) console.log(`fair price source problem: ${e}`)
;(async () => { while (!stopping) { await sleep(60_000); await ctx.fair.refresh().catch(() => {}) } })()

// Chain lifecycle, every 10 minutes: promote watch chains that found enough gaps, pause live chains that lose.
;(async () => {
  while (!stopping) {
    await sleep(10 * 60_000)
    const now = Date.now()
    for (const k of keys) {
      const s = ctx.store.state.chains[k]
      const next = nextState(s, now, ctx.ledger.since(k, now - LIFECYCLE.reviewDays * 86_400_000), ctx.status.get(k)?.gasOk ?? false)
      if (!next) continue
      ctx.store.state.chains[k] = next
      ctx.store.save()
      console.log(`[${k}] ${next.note}`)
      notify(`Peg Hunter ${k}: ${next.note}`)
    }
  }
})()

// Treasury: only when trading for real.
if (live) (async () => {
  const every = Number(process.env.TREASURY_MIN ?? '10') * 60_000
  await sleep(60_000) // let the desks start first
  while (!stopping) {
    try { await treasuryRound({ store: ctx.store, ledger: ctx.ledger, locks: ctx.locks, chains: keys.map((k) => CHAINS[k]) }, { go: true }) }
    catch (e: any) { console.log(`treasury error: ${String(e?.message ?? e).split('\n')[0]}`) }
    await sleep(every)
  }
})()

telegramLoop(ctx, keys).catch((e) => console.log(`telegram stopped: ${e?.message ?? e}`))

// Ctrl+C: let any chain finish the trade it is in, then exit.
process.on('SIGINT', () => {
  stopping = true
  console.log('stop requested' + (ctx.busy.n ? '; finishing current trades first' : ''))
  if (!ctx.busy.n) process.exit(0)
  const t = setInterval(() => { if (!ctx.busy.n) { clearInterval(t); console.log('stopped cleanly'); process.exit(0) } }, 500)
})

console.log(`Peg Hunter ${live ? 'LIVE' : 'WATCH ONLY'} | chains: ${keys.map((k) => `${k} (${ctx.store.state.chains[k].mode})`).join(', ')}`)
notify(`Peg Hunter started ${live ? 'LIVE' : 'watch only'}: ${keys.join(', ')}`)
await Promise.all(keys.map((k) => runChain(CHAINS[k], ctx).catch((e) => console.error(`[${k}] stopped: ${e?.shortMessage ?? e?.message ?? e}`))))
