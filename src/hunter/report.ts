// npm run report  (read-only): what each chain has seen and earned, and how close watch chains are to going live.
// Use it to decide which chains are worth moving to Render.
import 'dotenv/config'
import { DATA_DIR } from '../config.js'
import { CHAINS, chainKeys } from './chains.js'
import { readJsonl } from './desk.js'
import { LIFECYCLE } from './policy.js'
import { Ledger, Store } from './store.js'

const days = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? '3')
const keys = chainKeys().filter((k) => CHAINS[k])
const S = new Store(keys).state, L = new Ledger(), now = Date.now(), from = now - days * 86_400_000
const money = (x: number) => `${x >= 0 ? '+' : '-'}$${Math.abs(x).toFixed(Math.abs(x) < 1 ? 4 : 2)}`

console.log(`Peg Hunter report, last ${days} days (npm run report -- 7 for a week)`)
console.log(`profit all time ${money(keys.reduce((a, k) => a + L.cum(k), 0))}, last ${days}d ${money(L.since(null, from))}, swept $${S.sweptUsd.toFixed(2)}\n`)

for (const k of keys) {
  const c = S.chains[k]
  const age = (now - c.since) / 86_400_000
  console.log(`${k}: ${c.mode}${c.manual ? ' (set by hand)' : ''} for ${age.toFixed(1)} days${c.note ? ` - ${c.note}` : ''}`)
  if (c.mode === 'watch') {
    const left = Math.max(0, LIFECYCLE.watchDays - age)
    console.log(`  seen ${c.watchOpps}/${LIFECYCLE.promoteOpps} gaps worth $${c.watchUsd.toFixed(2)}/$${LIFECYCLE.promoteUsd.toFixed(2)}${left > 0 ? `; ${left.toFixed(1)} days of watching left` : ''}`)
  } else {
    console.log(`  realized ${money(L.since(k, from))} in ${L.trades(k, from)} trades (last ${days}d), all time ${money(L.cum(k))}`)
  }
  const opps = readJsonl(`${DATA_DIR}/${k}/opps.jsonl`).filter((o) => Date.parse(o.ts) >= from)
  if (opps.length) {
    const by = new Map<string, { n: number; sum: number; best: number; gap: number }>()
    for (const o of opps) {
      const r = by.get(o.route) ?? { n: 0, sum: 0, best: 0, gap: 0 }
      r.n++; r.sum += o.net; r.best = Math.max(r.best, o.net); r.gap = Math.max(r.gap, o.gapPct ?? 0)
      by.set(o.route, r)
    }
    console.log('  best routes (times seen, total, best, widest gap):')
    for (const [route, r] of [...by].sort((a, b) => b[1].sum - a[1].sum).slice(0, 5))
      console.log(`    ${route.padEnd(36)} ${String(r.n).padStart(4)}x  ${money(r.sum).padStart(9)}  best ${money(r.best)}  ${r.gap.toFixed(2)}%`)
  }
  // How long gaps stayed open: runs of consecutive scans where the same route was worth trading.
  const scans = readJsonl(`${DATA_DIR}/${k}/scans.jsonl`).filter((s) => Date.parse(s.ts) >= from)
  const runs: number[] = []
  let cur: { route: string; start: number; last: number } | null = null
  for (const s of scans) {
    const t = Date.parse(s.ts)
    if (s.would && cur && cur.route === s.route && t - cur.last < 120_000) { cur.last = t; continue }
    if (cur) runs.push(cur.last - cur.start)
    cur = s.would ? { route: s.route, start: t, last: t } : null
  }
  if (cur) runs.push(cur.last - cur.start)
  if (runs.length) {
    runs.sort((a, b) => a - b)
    console.log(`  gaps stayed open: median ${Math.round(runs[runs.length >> 1] / 1000)}s, longest ${Math.round(runs[runs.length - 1] / 60_000)} min (${runs.length} gaps)`)
  } else if (scans.length) console.log(`  ${scans.length} scans, no gap worth trading yet`)
  console.log('')
}
process.exit(0)
