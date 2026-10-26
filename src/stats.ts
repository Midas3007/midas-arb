// Trades and profit per hour from trades.jsonl.  npm run stats   (TZ_OFFSET=1 shows Nigeria time, the default)
import { existsSync, readFileSync } from 'node:fs'

const file = (process.env.DATA_DIR ?? '.') + '/trades.jsonl'
const offsetH = Number(process.env.TZ_OFFSET ?? '1')
if (!existsSync(file)) { console.log(`No ${file} yet. Run the desk first.`); process.exit(0) }

const rows = readFileSync(file, 'utf8').split('\n').flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
const cycles = rows.filter((e) => e.event === 'cycle' && e.live && typeof e.pnl === 'number')
const failed = rows.filter((e) => e.event === 'cycle' && e.live && e.pnl === null).length
if (!cycles.length) { console.log('No completed live trades yet.'); process.exit(0) }

const local = (ts: string) => new Date(Date.parse(ts) + offsetH * 3_600_000).toISOString()
const hours = new Map<string, { n: number; p: number }>()
const byRoute = new Map<string, { n: number; p: number }>()
for (const c of cycles) {
  const h = local(c.ts).slice(0, 13).replace('T', ' ') + ':00'
  const b = hours.get(h) ?? { n: 0, p: 0 }; b.n++; b.p += c.pnl; hours.set(h, b)
  const rk = String(c.route ?? c.X)
  const r = byRoute.get(rk) ?? { n: 0, p: 0 }; r.n++; r.p += c.pnl; byRoute.set(rk, r)
}
const $ = (v: number) => (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(2)

console.log(`Hour (UTC${offsetH >= 0 ? '+' : ''}${offsetH})        Trades   Profit   Avg/trade`)
for (const [h, b] of [...hours].sort()) console.log(`${h}   ${String(b.n).padStart(6)}  ${$(b.p).padStart(8)}  ${$(b.p / b.n).padStart(9)}`)

const total = cycles.reduce((s, c) => s + c.pnl, 0)
const spanH = Math.max(1, (Date.parse(cycles[cycles.length - 1].ts) - Date.parse(cycles[0].ts)) / 3_600_000)
const best = [...hours].sort((a, b) => b[1].p - a[1].p)[0]
console.log('\nBy route')
for (const [r, b] of [...byRoute].sort((a, b) => b[1].p - a[1].p)) console.log(`  ${r.padEnd(28)} ${String(b.n).padStart(5)} trades  ${$(b.p).padStart(8)}`)
console.log(`
Trades:           ${cycles.length} completed, ${failed} incomplete
Profit:           ${$(total)}
Avg per trade:    ${$(total / cycles.length)}
Trades per hour:  ${(cycles.length / spanH).toFixed(1)}   (over ${spanH.toFixed(1)} h from first to last trade)
Profit per hour:  ${$(total / spanH)}
Best hour:        ${best[0]}  ${best[1].n} trades  ${$(best[1].p)}`)
