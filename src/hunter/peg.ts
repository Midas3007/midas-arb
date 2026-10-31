// The "peg" rules: what makes a gap a trade and what makes it a trap. Pure logic, unit-tested (test/peg.test.ts).
//
// dev (deviation) = a pool's price / the fair price - 1. -0.02 means the pool sells the coin 2% below its
// real exchange rate.
//
// Traps:
// - Depeg: when EVERY pool of a coin on a chain is off in the same direction by more than DEPEG_PCT, the coin
//   itself has lost its peg (issuer or bridge trouble). Each pool looks "cheap" and buying would never stop.
//   The coin is frozen on that chain. When that happens on two or more chains at once, the whole currency is
//   frozen everywhere.
// - Stuck pool: a pool that has been off by more than DEPEG_PCT for more than STUCK_HOURS is not a gap nobody
//   noticed; something stops people trading it (a paused token, a transfer tax). Skipped.
// - Suspicious: a quote more than SUSPICIOUS_PCT away from fair is a broken pool or a fake token. Skipped.

export type PegRules = { depegPct: number; suspiciousPct: number; stuckHours: number; minGapPct: number; minNetUsd: number }
export const RULES: PegRules = {
  depegPct: Number(process.env.DEPEG_PCT ?? '3'),
  suspiciousPct: Number(process.env.SUSPICIOUS_PCT ?? '20'),
  stuckHours: Number(process.env.STUCK_HOURS ?? '24'),
  minGapPct: Number(process.env.MIN_GAP_PCT ?? '0.3'),
  minNetUsd: Number(process.env.MIN_NET_USD ?? '0.01'),
}

type Obs = { chain: string; token: string; ccy: string; venue: string; dev: number; at: number; offSince: number | null }
const FRESH_MS = 15 * 60_000

export class PegBoard {
  private obs = new Map<string, Obs>()
  private frozenNow = new Map<string, string>() // key -> reason, to report changes once
  constructor(private rules: PegRules = RULES, private onChange: (msg: string) => void = () => {}) {}

  observe(chain: string, token: string, ccy: string, venue: string, dev: number, at = Date.now()) {
    const k = `${chain}|${token}|${venue}`
    const prev = this.obs.get(k)
    const off = Math.abs(dev) * 100 > this.rules.depegPct
    const back = Math.abs(dev) * 100 < 1
    const offSince = off ? (prev?.offSince ?? at) : back ? null : (prev?.offSince ?? null)
    this.obs.set(k, { chain, token, ccy, venue, dev, at, offSince })
  }

  private fresh(now: number, f: (o: Obs) => boolean) {
    return [...this.obs.values()].filter((o) => now - o.at <= FRESH_MS && f(o))
  }

  // Why this coin is frozen on this chain, or null. +1/-1: which way it is off.
  private tokenDepeg(chain: string, token: string, now: number): { why: string; sign: number } | null {
    const os = this.fresh(now, (o) => o.chain === chain && o.token === token)
    if (os.length < 2) return null
    const limit = this.rules.depegPct / 100
    if (os.every((o) => o.dev < -limit)) return { why: `${token} on ${chain}: all ${os.length} pools below the peg (${pct(Math.max(...os.map((o) => o.dev)))} or worse)`, sign: -1 }
    if (os.every((o) => o.dev > limit)) return { why: `${token} on ${chain}: all ${os.length} pools above the peg (${pct(Math.min(...os.map((o) => o.dev)))} or more)`, sign: 1 }
    return null
  }

  // Currency frozen everywhere: coins of it depegged the same way on two or more chains.
  private ccyDepeg(ccy: string, now: number): string | null {
    const pairs = new Set(this.fresh(now, (o) => o.ccy === ccy).map((o) => `${o.chain}|${o.token}`))
    const bySign = new Map<number, Set<string>>()
    for (const p of pairs) {
      const [chain, token] = p.split('|')
      const d = this.tokenDepeg(chain, token, now)
      if (d) bySign.set(d.sign, new Set([...(bySign.get(d.sign) ?? []), chain]))
    }
    for (const [sign, chains] of bySign) if (chains.size >= 2) return `${ccy} ${sign < 0 ? 'below' : 'above'} its peg on ${[...chains].join(', ')}`
    return null
  }

  // Why trading this coin on this chain is blocked, or null. Reports each freeze and unfreeze once.
  frozen(chain: string, token: string, ccy: string, now = Date.now()): string | null {
    const why = this.ccyDepeg(ccy, now) ?? this.tokenDepeg(chain, token, now)?.why ?? null
    const k = `${chain}|${token}`
    const was = this.frozenNow.get(k)
    if (why && !was) { this.frozenNow.set(k, why); this.onChange(`FROZEN (depeg): ${why}. Not trading it until its pools come back.`) }
    if (!why && was) { this.frozenNow.delete(k); this.onChange(`unfrozen: ${token} on ${chain} is back near its peg`) }
    return why
  }

  stuck(chain: string, token: string, venue: string, now = Date.now()): boolean {
    const o = this.obs.get(`${chain}|${token}|${venue}`)
    return !!o?.offSince && now - o.offSince > this.rules.stuckHours * 3_600_000
  }

  // For /status and the report: pools currently off their peg by more than `minPct`.
  offPeg(minPct: number, now = Date.now()): Obs[] {
    return this.fresh(now, (o) => Math.abs(o.dev) * 100 >= minPct).sort((a, b) => Math.abs(b.dev) - Math.abs(a.dev))
  }
}
const pct = (d: number) => `${d >= 0 ? '+' : ''}${(d * 100).toFixed(2)}%`

// Deviation of a pool from fair, from a small round trip through it: buy price and sell price straddle the
// pool's mid price (the gap between them is the pool's fee), so the mid is their geometric mean.
export function poolDev(usdIn: number, tokensOut: number, usdBack: number, fairUsdPer: number): number | null {
  if (!(usdIn > 0 && tokensOut > 0 && usdBack > 0 && fairUsdPer > 0)) return null
  const buyPx = usdIn / tokensOut, sellPx = usdBack / tokensOut
  return Math.sqrt(buyPx * sellPx) / fairUsdPer - 1
}

// Every reason a found gap may not be traded, in one place. null = trade it.
export function blockReason(o: {
  fairOk: boolean; fairNote: string; frozen: string | null; stuckBuy: boolean; stuckSell: boolean
  buyDev: number | null; sellDev: number | null; sizeUsd: number; netUsd: number
}, rules: PegRules = RULES): string | null {
  if (!o.fairOk) return `no fair price (${o.fairNote})`
  if (o.frozen) return `frozen: ${o.frozen}`
  const s = rules.suspiciousPct / 100
  if ((o.buyDev !== null && Math.abs(o.buyDev) > s) || (o.sellDev !== null && Math.abs(o.sellDev) > s))
    return `suspicious price (buy ${o.buyDev === null ? '?' : pct(o.buyDev)}, sell ${o.sellDev === null ? '?' : pct(o.sellDev)} vs fair): broken pool or fake token`
  if (o.stuckBuy || o.stuckSell) return `pool off its peg for over ${rules.stuckHours}h (something stops trading there)`
  if (o.netUsd < rules.minNetUsd) return `profit $${o.netUsd.toFixed(4)} under $${rules.minNetUsd}`
  if (o.sizeUsd <= 0 || (o.netUsd / o.sizeUsd) * 100 < rules.minGapPct) return `gap ${((o.netUsd / Math.max(o.sizeUsd, 1e-9)) * 100).toFixed(2)}% under ${rules.minGapPct}% after gas and fees`
  return null
}

// Largest trade on a chain: TRADE_PCT (20%) of the chain's cash, never above MAX_TRADE_USD_CAP. A small wallet
// may still trade up to FLOOR_TRADE_USD ($2) so it can trade at all, and never more than 90% of its cash.
export function maxTradeUsd(cashUsd: number, o = {
  pct: Number(process.env.TRADE_PCT ?? '20'), cap: Number(process.env.MAX_TRADE_USD_CAP ?? '100'), floor: Number(process.env.FLOOR_TRADE_USD ?? '2'),
}): number {
  if (cashUsd <= 0) return 0
  const byPct = (cashUsd * o.pct) / 100
  const small = Math.min(o.floor, cashUsd * 0.9)
  return Math.min(o.cap, Math.max(byPct, small), cashUsd * 0.9)
}
