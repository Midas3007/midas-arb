// Fair price of each currency in dollars: the real exchange rate a pegged stablecoin should trade at.
//
// Sources (no API keys needed):
//   mento   Mento's on-chain oracles on Celo (SortedOracles median). Updated within minutes while FX markets are
//           open. Covers the currencies Mento trades (NGN, KES, GHS, BRL, PHP, COP, XOF, ZAR, CAD, AUD...).
//   erapi   open.er-api.com, updated daily, every currency.
//   fawaz   the fawazahmed0 currency API (jsDelivr CDN), updated daily, every currency.
// A currency is tradable only when at least two fresh sources agree within FAIR_AGREE_PCT (default 2%).
// One fresh source only: not tradable unless ALLOW_SINGLE_SOURCE=1. USD is always 1.
//
// FX markets close for the weekend (Friday evening to Sunday evening UTC) and the oracles stop updating, so a
// price may be older then without counting as stale.
import { createPublicClient, erc20Abi, fallback, http, parseAbi, type Address } from 'viem'
import { celo } from 'viem/chains'

export type Quote = { source: string; usdPer: number; at: number } // USD per 1 unit of the currency; at = ms
export type FairStatus = 'ok' | 'single' | 'disagree' | 'none'
export type Fair = { ccy: string; usdPer: number | null; status: FairStatus; sources: Quote[]; note: string }

// Friday 20:00 UTC to Sunday 23:00 UTC (a little wider than the real FX weekend, to be safe).
export function fxClosed(now: number): boolean {
  const d = new Date(now), day = d.getUTCDay(), h = d.getUTCHours()
  return (day === 5 && h >= 20) || day === 6 || (day === 0 && h < 23)
}
// How old a price may be: live oracles 2 h (80 h over a weekend), daily feeds 36 h (96 h over a weekend).
export function maxAgeMs(kind: 'live' | 'daily', now: number): number {
  const h = 3_600_000
  if (kind === 'live') return fxClosed(now) ? 80 * h : 2 * h
  return fxClosed(now) ? 96 * h : 36 * h
}
const KIND: Record<string, 'live' | 'daily'> = { mento: 'live', erapi: 'daily', fawaz: 'daily' }

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// Pure: turn the sources' quotes into one fair price and a verdict.
export function combine(ccy: string, quotes: Quote[], now: number, opts: { agreePct: number; allowSingle: boolean }): Fair {
  if (ccy === 'USD') return { ccy, usdPer: 1, status: 'ok', sources: [], note: '' }
  const fresh = quotes.filter((q) => q.usdPer > 0 && Number.isFinite(q.usdPer) && now - q.at <= maxAgeMs(KIND[q.source] ?? 'daily', now))
  const stale = quotes.filter((q) => !fresh.includes(q)).map((q) => q.source)
  const staleNote = stale.length ? ` (stale: ${stale.join(', ')})` : ''
  if (!fresh.length) return { ccy, usdPer: null, status: 'none', sources: [], note: `no fresh price${staleNote}` }
  const mid = median(fresh.map((q) => q.usdPer))
  const worst = Math.max(...fresh.map((q) => Math.abs(q.usdPer / mid - 1) * 100))
  if (fresh.length >= 2 && worst > opts.agreePct)
    return { ccy, usdPer: null, status: 'disagree', sources: fresh, note: `sources disagree by ${worst.toFixed(2)}%: ${fresh.map((q) => `${q.source} ${(1 / q.usdPer).toPrecision(5)}`).join(', ')}` }
  if (fresh.length === 1)
    return { ccy, usdPer: opts.allowSingle ? mid : null, status: 'single', sources: fresh, note: `only ${fresh[0].source}${staleNote}` }
  return { ccy, usdPer: mid, status: 'ok', sources: fresh, note: staleNote.trim() }
}

const brokerAbi = parseAbi(['function getExchangeProviders() view returns (address[])'])
const providerAbi = parseAbi([
  'function getExchanges() view returns ((bytes32 exchangeId, address[] assets)[])',
  'function getPoolExchange(bytes32) view returns ((address asset0, address asset1, address pricingModule, uint256 bucket0, uint256 bucket1, uint256 lastBucketUpdate, (uint256 spread, address referenceRateFeedID, uint256 referenceRateResetFrequency, uint256 minimumReports, uint256 stablePoolResetSize) config))',
  'function sortedOracles() view returns (address)',
])
const oracleAbi = parseAbi(['function medianRate(address) view returns (uint256, uint256)', 'function medianTimestamp(address) view returns (uint256)'])
const USDM = '0x765de816845861e75a25fca122bb6898b8b1282a'

export class FairPrices {
  private quotes = new Map<string, Map<string, Quote>>() // ccy -> source -> quote
  private feeds: { ccy: string; oracles: Address; feed: Address }[] = []
  private feedsAt = 0
  private dailyAt = 0
  private mentoAt = 0
  readonly agreePct = Number(process.env.FAIR_AGREE_PCT ?? '2')
  readonly allowSingle = process.env.ALLOW_SINGLE_SOURCE === '1'
  private celo = createPublicClient({
    chain: celo,
    transport: fallback((process.env.CELO_RPCS ?? 'https://forno.celo.org,https://celo-rpc.publicnode.com').split(',').map((u) => http(u.trim(), { timeout: 15_000 }))),
    batch: { multicall: true },
  })
  errors: string[] = []

  private put(ccy: string, q: Quote) {
    if (!this.quotes.has(ccy)) this.quotes.set(ccy, new Map())
    this.quotes.get(ccy)!.set(q.source, q)
  }

  // Mento's exchanges against USDm tell which oracle feed prices which currency (token XXXm -> currency XXX).
  private async mentoFeeds() {
    const broker = (process.env.MENTO_BROKER ?? '0x777A8255cA72412f0d706dc03C9D1987306B4CaD') as Address
    const out: typeof this.feeds = []
    for (const provider of await this.celo.readContract({ address: broker, abi: brokerAbi, functionName: 'getExchangeProviders' })) {
      const oracles = await this.celo.readContract({ address: provider, abi: providerAbi, functionName: 'sortedOracles' }).catch(() => null)
      if (!oracles) continue
      const exs = await this.celo.readContract({ address: provider, abi: providerAbi, functionName: 'getExchanges' }).catch(() => [])
      for (const ex of exs) {
        if (ex.assets.length !== 2) continue
        const other = ex.assets.find((a) => a.toLowerCase() !== USDM)
        if (!other || !ex.assets.some((a) => a.toLowerCase() === USDM)) continue
        const sym = await this.celo.readContract({ address: other, abi: erc20Abi, functionName: 'symbol' }).catch(() => '')
        const m = /^([A-Z]{3})m$/.exec(sym)
        if (!m) continue
        const pe = await this.celo.readContract({ address: provider, abi: providerAbi, functionName: 'getPoolExchange', args: [ex.exchangeId] }).catch(() => null)
        if (pe) out.push({ ccy: m[1], oracles, feed: pe.config.referenceRateFeedID })
      }
    }
    this.feeds = out
  }

  private async refreshMento(now: number) {
    if (!this.feeds.length || now - this.feedsAt > 6 * 3_600_000) { await this.mentoFeeds(); this.feedsAt = now }
    await Promise.all(this.feeds.map(async (f) => {
      const [[n, d], ts] = await Promise.all([
        this.celo.readContract({ address: f.oracles, abi: oracleAbi, functionName: 'medianRate', args: [f.feed] }),
        this.celo.readContract({ address: f.oracles, abi: oracleAbi, functionName: 'medianTimestamp', args: [f.feed] }),
      ])
      if (d > 0n && n > 0n) this.put(f.ccy, { source: 'mento', usdPer: Number(n) / Number(d), at: Number(ts) * 1000 })
    }))
  }

  private async refreshDaily() {
    const get = (url: string) => fetch(url, { signal: AbortSignal.timeout(20_000) }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as any })
    const [er, fz] = await Promise.allSettled([
      get('https://open.er-api.com/v6/latest/USD'),
      get('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json')
        .catch(() => get('https://latest.currency-api.pages.dev/v1/currencies/usd.json')),
    ])
    if (er.status === 'fulfilled' && er.value?.rates) {
      const at = Number(er.value.time_last_update_unix) * 1000
      for (const [c, r] of Object.entries(er.value.rates)) if (Number(r) > 0) this.put(c.toUpperCase(), { source: 'erapi', usdPer: 1 / Number(r), at })
    } else if (er.status === 'rejected') this.errors.push(`erapi: ${String(er.reason?.message ?? er.reason)}`)
    if (fz.status === 'fulfilled' && fz.value?.usd) {
      const at = Date.parse(`${fz.value.date}T00:00:00Z`)
      for (const [c, r] of Object.entries(fz.value.usd)) if (/^[a-z]{3}$/.test(c) && Number(r) > 0) this.put(c.toUpperCase(), { source: 'fawaz', usdPer: 1 / Number(r), at })
    } else if (fz.status === 'rejected') this.errors.push(`fawaz: ${String(fz.reason?.message ?? fz.reason)}`)
  }

  // Cheap to call often: Mento every 2 minutes, the daily feeds every hour.
  async refresh(now = Date.now()) {
    this.errors = []
    const jobs: Promise<unknown>[] = []
    if (now - this.mentoAt > 120_000) { this.mentoAt = now; jobs.push(this.refreshMento(now).catch((e) => this.errors.push(`mento: ${String(e?.shortMessage ?? e?.message ?? e).split('\n')[0]}`))) }
    if (now - this.dailyAt > 3_600_000) { this.dailyAt = now; jobs.push(this.refreshDaily()) }
    await Promise.all(jobs)
  }

  get(ccy: string, now = Date.now()): Fair {
    return combine(ccy, [...(this.quotes.get(ccy)?.values() ?? [])], now, { agreePct: this.agreePct, allowSingle: this.allowSingle })
  }
}
