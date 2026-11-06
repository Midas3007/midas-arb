// FX gap survey: how often, and by how much, each currency coin could be bought on one exchange and sold on
// another (Textile included) for a profit after gas, on the chains Textile serves. Uses the bot's own exchange code
// (honest quotes: every call carries a real gas price). Quotes only: nothing is ever sent.
//
//   npm run survey                                # celo, base, bsc, polygon; 30 rounds, one a minute
//   npm run survey -- celo,base --rounds 10 --every 30 --sizes 25,100,200
//
// Every round quotes each coin at each size on every exchange that has it (buy), then sells what that bought on
// every other exchange. Each round is saved to data/survey/rounds.jsonl; `npm run survey-report` summarizes them.
import 'dotenv/config'
process.env.DESK_QUOTE_ONLY = '1'
process.env.HUNTER_LIVE = '0'
import { appendFileSync, mkdirSync } from 'node:fs'
import { CHAINS } from './chains.js'
import { pruneRpcs } from './clients.js'
import { runChain, type Ctx, type FxDesk } from './desk.js'
import { FairPrices } from './fair.js'
import { PegBoard } from './peg.js'
import { Ledger, Locks, Store } from './store.js'

const args = process.argv.slice(2)
const opt = (k: string, d: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d }
const keys = (args[0] && !args[0].startsWith('--') ? args[0] : 'celo,base,bsc,polygon').split(',').filter((k) => CHAINS[k])
const ROUNDS = Number(opt('rounds', '30')), EVERY = Number(opt('every', '60')) * 1000
const SIZES = opt('sizes', '25,100,200').split(',').map(Number)
const OUT = `${process.env.DATA_DIR ?? 'data'}/survey`
mkdirSync(OUT, { recursive: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let stopping = false
process.on('SIGINT', () => { stopping = true })
const ctx: Ctx = { store: new Store(keys), ledger: new Ledger(), fair: new FairPrices(), board: new PegBoard(), locks: new Locks(), live: false, status: new Map(), stopping: () => stopping, fx: new Map() }
await ctx.fair.refresh()
for (const k of keys) await pruneRpcs(CHAINS[k], () => {})
const say = console.log
console.log = (...a: unknown[]) => { const s = a.join(' '); if (/discovery:|coins with a route|RPC not answering|error/i.test(s)) say(...a) }
for (const k of keys) runChain(CHAINS[k], ctx).catch((e) => say(`[${k}] stopped: ${e?.message ?? e}`))

// Wait for every desk to find its pools.
for (let i = 0; i < 120 && keys.some((k) => !ctx.fx!.get(k)?.coins().length); i++) await sleep(5000)

export type SurveyRow = { chain: string; X: string; ccy: string; size: number; buy: string; sell: string; out: number; gas: number; net: number }
export type SurveyDev = { chain: string; X: string; venue: string; devPct: number } // price paid there vs fair, at $100

async function surveyChain(d: FxDesk): Promise<{ rows: SurveyRow[]; devs: SurveyDev[] }> {
  const rows: SurveyRow[] = [], devs: SurveyDev[] = []
  const venues = d.venues()
  await Promise.all(d.coins().filter((c) => c.ccy !== 'USD').map(async (c) => {
    const fair = ctx.fair.get(c.ccy).usdPer // USD per unit
    for (const size of SIZES) {
      const amt = BigInt(Math.round(size * 1e6))
      const buys = await Promise.all(venues.map((v) => v.quote('USDT', c.X, amt).catch(() => null)))
      const have = venues.flatMap((v, i) => (buys[i] && buys[i]! > 0n ? [{ v, out: buys[i]! }] : []))
      if (size === 100 && fair) for (const b of have) devs.push({ chain: d.chain, X: c.X, venue: b.v.name, devPct: ((size / (Number(b.out) / 10 ** c.decimals)) / fair - 1) * 100 })
      // Sell on every other exchange, not only those that can also buy (some Textile corridors only buy from you).
      await Promise.all(have.map((b) => Promise.all(venues.filter((v) => v !== b.v).map(async (sv) => {
        const s = { v: sv }
        const back = await s.v.quote(c.X, 'USDT', b.out).catch(() => null)
        if (!back) return
        const gas = await d.gasUsd(b.v.gas + s.v.gas)
        const out = Number(back) / 1e6
        rows.push({ chain: d.chain, X: c.X, ccy: c.ccy, size, buy: b.v.name, sell: s.v.name, out, gas, net: out - size - gas })
      }))))
    }
  }))
  return { rows, devs }
}

const t0 = Date.now()
for (let r = 1; r <= ROUNDS && !stopping; r++) {
  const start = Date.now()
  const res = await Promise.all(keys.map((k) => surveyChain(ctx.fx!.get(k)!).catch(() => ({ rows: [] as SurveyRow[], devs: [] as SurveyDev[] }))))
  const rows = res.flatMap((x) => x.rows), devs = res.flatMap((x) => x.devs)
  appendFileSync(`${OUT}/rounds.jsonl`, JSON.stringify({ ts: new Date().toISOString(), rows, devs }) + '\n')
  const wins = rows.filter((x) => x.net > 0).sort((a, b) => b.net - a.net)
  say(`round ${r}/${ROUNDS} (${((Date.now() - start) / 1000).toFixed(0)} s, ${rows.length} routes): ${wins.length ? wins.slice(0, 6).map((w) => `${w.chain} ${w.X} ${w.buy}->${w.sell} $${w.size} +$${w.net.toFixed(3)}`).join(' | ') : 'no route pays after gas'}`)
  if (r < ROUNDS) await sleep(Math.max(0, EVERY - (Date.now() - start)))
}
say(`done in ${((Date.now() - t0) / 60_000).toFixed(1)} min; rounds in ${OUT}/rounds.jsonl`)
process.exit(0)
