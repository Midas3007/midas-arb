// Money-management rules: when a chain may trade, how cash is split between chains, and when profit is swept to
// the withdrawal chain. Pure functions, unit-tested (test/policy.test.ts).

// ---------------- chain lifecycle ----------------
// watch:  scans and records what it WOULD have earned; trades nothing. Every chain starts here.
// live:   trades (if HUNTER_LIVE=1). Reached after WATCH_DAYS (3) if the scanner saw at least PROMOTE_MIN_OPPS (5)
//         real gaps worth at least PROMOTE_MIN_USD ($0.10) in total, and a swap costs under MAX_SWAP_GAS_USD.
// paused: a live chain that made no money (after gas) over its last REVIEW_DAYS (7). Its cash moves to the
//         others. After PAUSED_DAYS (7) it goes back to watch and can earn its place again.
// manual: set from Telegram (/chain base live|watch|off); automatic rules then leave that chain alone until
//         /chain base auto.
export type Mode = 'watch' | 'live' | 'paused'
export type ChainState = {
  mode: Mode
  since: number // ms, when it entered this mode
  manual?: boolean
  watchOpps: number // gaps seen in watch mode (one per route per 10 minutes)
  watchUsd: number // what they would have earned
  note?: string
}
export type LifecycleRules = { watchDays: number; promoteOpps: number; promoteUsd: number; reviewDays: number; pausedDays: number }
export const LIFECYCLE: LifecycleRules = {
  watchDays: Number(process.env.WATCH_DAYS ?? '3'),
  promoteOpps: Number(process.env.PROMOTE_MIN_OPPS ?? '5'),
  promoteUsd: Number(process.env.PROMOTE_MIN_USD ?? '0.10'),
  reviewDays: Number(process.env.REVIEW_DAYS ?? '7'),
  pausedDays: Number(process.env.PAUSED_DAYS ?? '7'),
}
const DAY = 86_400_000

export const freshState = (mode: Mode, now: number, note?: string): ChainState => ({ mode, since: now, watchOpps: 0, watchUsd: 0, note })

// The next state of a chain, or null when nothing changes. netWindow: realized profit after gas over the last
// reviewDays (only used for live chains). gasOk: a swap costs under MAX_SWAP_GAS_USD.
export function nextState(s: ChainState, now: number, netWindow: number, gasOk: boolean, r: LifecycleRules = LIFECYCLE): ChainState | null {
  if (s.manual) return null
  const days = (now - s.since) / DAY
  if (s.mode === 'watch') {
    if (days < r.watchDays) return null
    if (!gasOk) return null
    if (s.watchOpps >= r.promoteOpps && s.watchUsd >= r.promoteUsd)
      return freshState('live', now, `promoted: ${s.watchOpps} gaps worth $${s.watchUsd.toFixed(2)} in ${days.toFixed(1)} days of watching`)
    return null
  }
  if (s.mode === 'live') {
    if (days >= r.reviewDays && netWindow <= 0)
      return freshState('paused', now, `paused: made $${netWindow.toFixed(4)} after gas in the last ${r.reviewDays} days`)
    return null
  }
  if (days >= r.pausedDays) return freshState('watch', now, `back to watching after ${r.pausedDays} days paused`)
  return null
}

// ---------------- splitting cash between chains ----------------
// Live chains get cash in proportion to what they earn per dollar (last REVIEW_DAYS), with every live chain
// getting at least MIN_SHARE_PCT (5%) and none more than MAX_SHARE_PCT (40%; lifted when there are too few live
// chains to stay under it). A chain with no history yet is scored like the median chain. All live chains equal
// when nobody has earned anything yet. Watch and paused chains get nothing.
export type AllocInput = { key: string; live: boolean; roi: number | null }
export function allocate(chains: AllocInput[], total: number, o = {
  minPct: Number(process.env.MIN_SHARE_PCT ?? '5'), maxPct: Number(process.env.MAX_SHARE_PCT ?? '40'),
}): Record<string, number> {
  const live = chains.filter((c) => c.live)
  if (!live.length || total <= 0) return {}
  const known = live.map((c) => c.roi).filter((x): x is number => x !== null).sort((a, b) => a - b)
  const med = known.length ? known[known.length >> 1] : 0
  let score = live.map((c) => Math.max(0, c.roi ?? med))
  if (score.every((s) => s === 0)) score = live.map(() => 1)
  const n = live.length
  const lo = Math.min(o.minPct / 100, 1 / n), hi = Math.max(o.maxPct / 100, 1 / n)
  // Water-filling: fix shares that hit a bound, split the rest by score, repeat.
  const share = new Array<number | null>(n).fill(null)
  for (let round = 0; round < n + 1; round++) {
    const free = share.map((s, i) => (s === null ? i : -1)).filter((i) => i >= 0)
    if (!free.length) break
    const left = 1 - share.reduce<number>((a, s) => a + (s ?? 0), 0)
    const sum = free.reduce((a, i) => a + score[i], 0)
    const want = free.map((i) => (sum > 0 ? (left * score[i]) / sum : left / free.length))
    let fixed = false
    free.forEach((i, j) => {
      if (want[j] > hi + 1e-12) { share[i] = hi; fixed = true }
      else if (want[j] < lo - 1e-12) { share[i] = lo; fixed = true }
    })
    if (!fixed) { free.forEach((i, j) => { share[i] = want[j] }); break }
  }
  const total1 = share.reduce<number>((a, s) => a + (s ?? 0), 0) || 1
  return Object.fromEntries(live.map((c, i) => [c.key, (total * (share[i] ?? 0)) / total1]))
}

// ---------------- sweeping profit to the withdrawal chain ----------------
// Profit is only ever what trades earned after gas, minus bridge fees (from the ledger). Deposits never count.
// Each chain has a high-water mark: its cumulative profit at its last sweep. When the profit above the marks
// reaches SWEEP_AT_USD ($20) across all chains, SWEEP_PCT (50%) of it is sent to the withdrawal chain; the rest
// stays and keeps trading. A chain whose part is under SWEEP_MIN_CHAIN_USD ($3) waits for a later sweep (its
// mark does not move, so nothing is lost).
export type SweepRules = { atUsd: number; pct: number; minChainUsd: number }
export const SWEEP: SweepRules = {
  atUsd: Number(process.env.SWEEP_AT_USD ?? '20'),
  pct: Number(process.env.SWEEP_PCT ?? '50'),
  minChainUsd: Number(process.env.SWEEP_MIN_CHAIN_USD ?? '3'),
}
export type SweepItem = { key: string; usd: number; newMark: number }
export function planSweep(chains: { key: string; cum: number; mark: number }[], r: SweepRules = SWEEP, force = false):
  { newProfit: number; due: boolean; items: SweepItem[]; waiting: string[] } {
  const parts = chains.map((c) => ({ ...c, up: Math.max(0, c.cum - c.mark) }))
  const newProfit = parts.reduce((a, c) => a + c.up, 0)
  const due = newProfit > 0 && (force || newProfit >= r.atUsd)
  if (!due) return { newProfit, due, items: [], waiting: [] }
  const items: SweepItem[] = [], waiting: string[] = []
  for (const c of parts) {
    if (c.up <= 0) continue
    const usd = (c.up * r.pct) / 100
    if (usd < r.minChainUsd) { waiting.push(c.key); continue }
    items.push({ key: c.key, usd: Math.floor(usd * 100) / 100, newMark: c.cum })
  }
  return { newProfit, due, items, waiting }
}
