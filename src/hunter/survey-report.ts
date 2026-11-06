// Summary of an FX gap survey (data/survey/rounds.jsonl, written by `npm run survey`): for each chain and coin,
// how often a route paid after gas, the best it paid, through which exchanges, and how far each exchange's price
// sat from the fair rate. `npm run survey-report` prints it; `-- --md docs/FX_SURVEY.md` also writes it as Markdown.
import { readFileSync, writeFileSync } from 'node:fs'
import type { SurveyDev, SurveyRow } from './survey.js'

const args = process.argv.slice(2)
const file = args.find((a) => a.endsWith('.jsonl')) ?? `${process.env.DATA_DIR ?? 'data'}/survey/rounds.jsonl`
const mdAt = args.indexOf('--md')
const rounds: { ts: string; rows: SurveyRow[]; devs: SurveyDev[] }[] = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
if (!rounds.length) { console.log('no rounds yet'); process.exit(0) }

type Agg = { chain: string; X: string; ccy: string; rounds: number; paidRounds: number; best: SurveyRow | null; closest: SurveyRow | null; textileBest: SurveyRow | null }
const agg = new Map<string, Agg>()
for (const r of rounds) {
  const seen = new Set<string>(), paid = new Set<string>()
  for (const x of r.rows) {
    const k = `${x.chain}|${x.X}`
    const a = agg.get(k) ?? { chain: x.chain, X: x.X, ccy: x.ccy, rounds: 0, paidRounds: 0, best: null, closest: null, textileBest: null }
    agg.set(k, a)
    seen.add(k)
    const pct = (y: SurveyRow | null) => (y ? y.net / y.size : -Infinity)
    if (x.net > 0) { paid.add(k); if (!a.best || x.net > a.best.net) a.best = x }
    if (pct(x) > pct(a.closest)) a.closest = x
    if ((x.buy === 'textile' || x.sell === 'textile') && pct(x) > pct(a.textileBest)) a.textileBest = x
  }
  for (const k of seen) agg.get(k)!.rounds++
  for (const k of paid) agg.get(k)!.paidRounds++
}
// Each exchange's typical price vs fair (median over rounds), coin by coin; broken pools (over 20% off) left out.
const devs = new Map<string, number[]>()
for (const r of rounds) for (const d of r.devs) if (Math.abs(d.devPct) < 20) devs.set(`${d.chain}|${d.X}|${d.venue}`, [...(devs.get(`${d.chain}|${d.X}|${d.venue}`) ?? []), d.devPct])
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1] }

const first = rounds[0].ts, last = rounds[rounds.length - 1].ts
const lines: string[] = []
const p = (s = '') => lines.push(s)
p(`# FX gap survey: ${rounds.length} rounds, ${first.slice(0, 16).replace('T', ' ')} to ${last.slice(11, 16)} UTC`)
p()
p('A round quotes every currency coin at each size on every exchange that has it, then sells what that bought on every other exchange (Textile included). "Paid" means after gas. Quotes only, nothing was traded.')
p()
p('| Chain | Coin | Rounds a route paid | Best paid (route, size, after gas) | Closest route (% of the trade) | Best Textile route |')
p('|---|---|---|---|---|---|')
const fmt = (x: SurveyRow | null) => (x ? `${x.buy} -> ${x.sell} $${x.size}: ${x.net >= 0 ? '+' : ''}$${x.net.toFixed(3)}` : '-')
const pc = (x: SurveyRow | null) => (x ? `${x.buy} -> ${x.sell} $${x.size}: ${((x.net / x.size) * 100).toFixed(3)}%` : '-')
for (const a of [...agg.values()].sort((a, b) => b.paidRounds - a.paidRounds || (b.closest!.net / b.closest!.size) - (a.closest!.net / a.closest!.size)))
  p(`| ${a.chain} | ${a.X} (${a.ccy}) | ${a.paidRounds} of ${a.rounds} | ${fmt(a.best)} | ${pc(a.closest)} | ${pc(a.textileBest)} |`)
p()
p('## Where each exchange prices the coin (median, % above fair when buying $100; broken pools left out)')
p()
p('| Chain | Coin | Exchange: price vs fair |')
p('|---|---|---|')
const byCoin = new Map<string, string[]>()
for (const [k, xs] of devs) { const [chain, X, venue] = k.split('|'); byCoin.set(`${chain}|${X}`, [...(byCoin.get(`${chain}|${X}`) ?? []), `${venue} ${med(xs) >= 0 ? '+' : ''}${med(xs).toFixed(2)}%`]) }
for (const [k, vs] of [...byCoin.entries()].sort()) { const [chain, X] = k.split('|'); p(`| ${chain} | ${X} | ${vs.join(', ')} |`) }
const out = lines.join('\n') + '\n'
console.log(out)
if (mdAt >= 0) writeFileSync(args[mdAt + 1], out)
