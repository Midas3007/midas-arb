// Summary of what the multi-chain desk saw and did: npm run multi-stats  (or: npm run multi-stats -- bsc)
// Scans: each scan's best route, from dry runs and live runs. Trades: completed live trades.
import { existsSync, readdirSync, readFileSync } from 'node:fs'

const want = process.argv.slice(2)
const dirs = readdirSync('.').filter((d) => d.startsWith('data-') && (!want.length || want.includes(d.slice(5))))
if (!dirs.length) { console.log('No data yet. Run: npm run multi -- bsc polygon base'); process.exit(0) }
const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) : [])
const $ = (v: number) => (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(4)

for (const d of dirs) {
  const scans = read(`${d}/scans.jsonl`), trades = read(`${d}/trades.jsonl`).filter((t: any) => typeof t.pnl === 'number')
  console.log(`\n=== ${d.slice(5).toUpperCase()} ===`)
  if (scans.length) {
    const hours = (Date.parse(scans[scans.length - 1].ts) - Date.parse(scans[0].ts)) / 3_600_000
    const would = scans.filter((s: any) => s.would)
    console.log(`Scans: ${scans.length} over ${hours.toFixed(1)} h   profitable chances: ${would.length}   expected total ${$(would.reduce((a: number, s: any) => a + s.net, 0))}`)
    const by = new Map<string, { n: number; hits: number; best: number; sum: number }>()
    for (const s of scans) {
      const b = by.get(s.route) ?? { n: 0, hits: 0, best: -Infinity, sum: 0 }
      b.n++; if (s.would) { b.hits++; b.sum += s.net }; b.best = Math.max(b.best, s.net); by.set(s.route, b)
    }
    console.log('Route (top of scan)                          times  chances  best net   expected')
    for (const [r, b] of [...by].sort((a, b) => b[1].best - a[1].best).slice(0, 12))
      console.log(`${r.padEnd(44)} ${String(b.n).padStart(5)}  ${String(b.hits).padStart(7)}  ${$(b.best).padStart(9)}  ${$(b.sum).padStart(9)}`)
  } else console.log('No scans saved yet.')
  if (trades.length) {
    const pnl = trades.reduce((a: number, t: any) => a + t.pnl, 0)
    console.log(`Live trades: ${trades.length}   profit ${$(pnl)}   avg ${$(pnl / trades.length)}`)
  }
}
