// FX execution-quality API: what a currency trade of a given size would actually get, per exchange, right now.
//
//   GET /fx                         currencies covered, with their oracle (fair) rate and where each trades
//   GET /fx/NGN?size=50000          per exchange: effective rate for buying and for selling $50,000 worth, the
//                                   slippage against a $10 trade there, and the spread against the oracle rate
//   GET /fx/NGN/history?hours=24    the recorded series (sizes $100, $1,000, $10,000, every FX_RECORD_MIN minutes)
//   GET /health
//
// Everything is computed from on-chain quotes (Uniswap, Aerodrome, Pancake, Curve, Mento...) and Textile's RFQ
// previews: the same honest quotes the trading desks use (every call carries a real gas price). It publishes what
// public contracts would execute at, not any bureau-de-change or parallel-market quote.
//
// Access (any mix):
//   FX_API_KEYS=key1,key2       callers sending x-api-key (or Authorization: Bearer) are served free
//   X402_PRICE_USD=0.01         everyone else pays per call with x402 (USDC on Base; v2 and v1, see x402.ts), settled
//                               by PayAI's facilitator (no account) or by this server (X402_FACILITATOR_URL=self).
//                               X402_PAY_TO: where the USDC goes (required without HUNTER_PRIVATE_KEY).
//   neither set                 open (for running it on your own machine)
//
// Discovery (free): / (a short page), /openapi.json (with x-payment-info, as x402scan reads it), /.well-known/x402
// (the list of paid URLs), /llms.txt (for language-model agents). PUBLIC_URL=https://... sets the address they give.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { DATA_DIR } from '../config.js'
import { hunterAccount } from './clients.js'
import { acceptPayment, challenge, payConfig, type Endpoint } from './x402.js'
import type { Ctx } from './desk.js'

const n = (k: string, d: string) => Number(process.env[k] ?? d)
const REF_USD = 10 // slippage is measured against a trade of this size on the same exchange
const RECORD_SIZES = [100, 1_000, 10_000]
const CACHE_MS = 10_000
const SUSPECT_BPS = n('SUSPICIOUS_PCT', '20') * 100 // further than this from the oracle: an empty or broken pool, left out
const sig = (x: number, d = 6) => Number(x.toPrecision(d))
const bps = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10)

export type SideQuote = { rate: number; amount: number; usd: number; spreadBps: number | null; slippageBps: number | null }
export type VenueRow = { chain: string; coin: string; venue: string; buy: SideQuote | null; sell: SideQuote | null }
export type FxQuote = {
  ccy: string; size: number; asOf: string
  oracle: { ratePerUsd: number | null; status: string; sources: string[] }
  venues: VenueRow[]
  best: { buy: VenueRow | null; sell: VenueRow | null }
  excluded: { chain: string; coin: string; venue: string; reason: string }[]
  notes: string[]
}

// Coins of one currency on every running desk.
function coinsOf(ctx: Ctx, ccy: string) {
  const out: { chain: string; X: string; decimals: number }[] = []
  for (const [chain, d] of ctx.fx ?? []) for (const c of d.coins()) if (c.ccy === ccy) out.push({ chain, X: c.X, decimals: c.decimals })
  return out
}
export function currencies(ctx: Ctx) {
  const m = new Map<string, { chain: string; coin: string }[]>()
  for (const [chain, d] of ctx.fx ?? []) for (const c of d.coins()) if (c.ccy !== 'USD') m.set(c.ccy, [...(m.get(c.ccy) ?? []), { chain, coin: c.X }])
  return [...m.entries()].sort().map(([ccy, coins]) => {
    const f = ctx.fair.get(ccy)
    return { ccy, oracleRatePerUsd: f.usdPer ? 1 / f.usdPer : null, oracleStatus: f.status, coins }
  })
}

// The quote engine. Buy: spend `size` dollars of the chain's cash token on the coin. Sell: sell the amount of the coin
// worth `size` dollars at the oracle rate. Rates are in currency units per dollar (NGN per USD).
export async function fxQuote(ctx: Ctx, ccy: string, size: number): Promise<FxQuote> {
  const f = ctx.fair.get(ccy)
  const oracle = f.usdPer ? 1 / f.usdPer : null
  const rows: VenueRow[] = []
  await Promise.all(coinsOf(ctx, ccy).map(async (c) => {
    const d = ctx.fx!.get(c.chain)!
    const unit = 10 ** c.decimals
    const sellUnits = oracle ? size * oracle : null
    await Promise.all(d.venues().map(async (v) => {
      const [b, bRef, s, sRef] = await Promise.all([
        v.quote('USDT', c.X, BigInt(Math.round(size * 1e6))).catch(() => null),
        v.quote('USDT', c.X, BigInt(REF_USD * 1e6)).catch(() => null),
        sellUnits ? v.quote(c.X, 'USDT', BigInt(Math.round(sellUnits * unit))).catch(() => null) : null,
        oracle ? v.quote(c.X, 'USDT', BigInt(Math.round(REF_USD * oracle * unit))).catch(() => null) : null,
      ])
      let buy: SideQuote | null = null, sell: SideQuote | null = null
      if (b && b > 0n) {
        const amount = Number(b) / unit, rate = amount / size
        const refRate = bRef && bRef > 0n ? Number(bRef) / unit / REF_USD : null
        buy = { rate: sig(rate), amount: sig(amount), usd: size, spreadBps: bps(oracle ? (1 - rate / oracle) * 1e4 : null), slippageBps: bps(refRate ? (1 - rate / refRate) * 1e4 : null) }
      }
      if (s && s > 0n && sellUnits && oracle) {
        const usd = Number(s) / 1e6, rate = sellUnits / usd
        const refRate = sRef && sRef > 0n ? (REF_USD * oracle) / (Number(sRef) / 1e6) : null
        sell = { rate: sig(rate), amount: sig(sellUnits), usd: Math.round(usd * 100) / 100, spreadBps: bps((rate / oracle - 1) * 1e4), slippageBps: bps(refRate ? (rate / refRate - 1) * 1e4 : null) }
      }
      if (buy || sell) rows.push({ chain: c.chain, coin: c.X, venue: v.name, buy, sell })
    }))
  }))
  // A price further than SUSPICIOUS_PCT from the oracle is an empty or broken pool: left out (and listed as such).
  const bad = (q: SideQuote | null) => !!q && q.spreadBps !== null && Math.abs(q.spreadBps) > SUSPECT_BPS
  const excluded = rows.filter((r) => bad(r.buy) || bad(r.sell)).map((r) => ({ chain: r.chain, coin: r.coin, venue: r.venue, reason: `price over ${SUSPECT_BPS / 100}% from the oracle (empty or broken pool)` }))
  const good = rows.filter((r) => !bad(r.buy) && !bad(r.sell))
  rows.length = 0; rows.push(...good)
  const bestBuy = rows.filter((r) => r.buy).sort((a, b) => b.buy!.rate - a.buy!.rate)[0] ?? null // most currency per dollar
  const bestSell = rows.filter((r) => r.sell).sort((a, b) => a.sell!.rate - b.sell!.rate)[0] ?? null // least currency per dollar received
  const notes: string[] = []
  if (!rows.length) notes.push('no exchange quotes this size right now')
  if (f.status !== 'ok') notes.push(`oracle: ${f.note || f.status}`)
  if (ccy === 'NGN' || ccy === 'ARS') notes.push('the oracle is the official rate; on-chain prices follow the market rate more closely')
  return {
    ccy, size, asOf: new Date().toISOString(),
    oracle: { ratePerUsd: oracle, status: f.status, sources: f.sources.map((s) => s.source) },
    venues: rows.sort((a, b) => a.chain.localeCompare(b.chain) || a.venue.localeCompare(b.venue)),
    best: { buy: bestBuy, sell: bestSell }, excluded, notes,
  }
}

// ---------- history ----------
const histDir = () => `${DATA_DIR}/fx`
const histFile = (day: string) => `${histDir()}/history-${day}.jsonl`
export async function recordOnce(ctx: Ctx) {
  if (!existsSync(histDir())) mkdirSync(histDir(), { recursive: true })
  const ts = new Date().toISOString()
  for (const c of currencies(ctx)) for (const size of RECORD_SIZES) {
    const q = await fxQuote(ctx, c.ccy, size).catch(() => null)
    if (!q) continue
    const lines = q.venues.map((r) => JSON.stringify({ ts, ccy: c.ccy, size, chain: r.chain, coin: r.coin, venue: r.venue, oracle: q.oracle.ratePerUsd, buy: r.buy?.rate ?? null, sell: r.sell?.rate ?? null }))
    if (lines.length) appendFileSync(histFile(ts.slice(0, 10)), lines.join('\n') + '\n')
  }
}
function history(ccy: string, hours: number, size?: number) {
  const since = Date.now() - hours * 3_600_000, out: any[] = []
  for (let d = Date.now() - hours * 3_600_000; d <= Date.now() + 86_400_000; d += 86_400_000) {
    const f = histFile(new Date(d).toISOString().slice(0, 10))
    if (!existsSync(f)) continue
    for (const l of readFileSync(f, 'utf8').split('\n')) {
      if (!l) continue
      try { const o = JSON.parse(l); if (o.ccy === ccy && Date.parse(o.ts) >= since && (!size || o.size === size)) out.push(o) } catch { /* partial line */ }
    }
  }
  return out
}

// ---------- discovery: how agents and directories find and call this ----------
const SERVICE = 'Midas FX Quotes' // 32 characters at most (Bazaar rule)
const TAGS = ['fx', 'stablecoins', 'naira', 'onchain', 'quotes']
const DESCRIPTION = 'Executable FX rates for currency stablecoins (cNGN, wBRL, wARS, EURC, XSGD, KESm...) on Celo, Base, BSC and Polygon: per exchange (Uniswap, Aerodrome, Pancake, Curve, Mento, Textile RFQ) the effective rate at your trade size, slippage, and spread against the official rate.'
const EXAMPLE = {
  ccy: 'NGN', size: 1000, asOf: '2026-11-06T09:33:51Z', oracle: { ratePerUsd: 1346.6, status: 'ok', sources: ['erapi', 'fawaz', 'mento'] },
  venues: [{ chain: 'celo', coin: 'cNGN', venue: 'textile', buy: { rate: 1376.72, amount: 1376724.7, usd: 1000, spreadBps: -223.7, slippageBps: 0 }, sell: { rate: 1377.28, amount: 1346601.3, usd: 977.73, spreadBps: 227.8, slippageBps: 0 } }],
  best: { buy: { chain: 'celo', coin: 'cNGN', venue: 'textile' }, sell: { chain: 'celo', coin: 'cNGN', venue: 'textile' } }, excluded: [], notes: [],
}
const HISTORY_EXAMPLE = { ccy: 'NGN', points: [{ ts: '2026-11-06T09:35:00Z', ccy: 'NGN', size: 1000, chain: 'celo', coin: 'cNGN', venue: 'textile', oracle: 1346.6, buy: 1376.72, sell: 1377.28 }] }

const baseUrl = (req: IncomingMessage) => (process.env.PUBLIC_URL?.replace(/\/$/, '') || `${String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0]}://${req.headers.host ?? 'localhost'}`)
function endpointFor(base: string, ccy: string, history: boolean, url: string): Endpoint {
  const q = new URL(url).searchParams, num = (k: string, d: number) => (Number(q.get(k)) > 0 ? Number(q.get(k)) : d)
  const iconUrl = process.env.PUBLIC_URL ? `${base}/icon.png` : undefined
  return history
    ? { url, description: `Recorded ${ccy} rates per exchange ($100, $1,000, $10,000 every 5 minutes)`, serviceName: SERVICE, tags: TAGS, iconUrl,
      queryParams: { hours: num('hours', 24), size: num('size', 1000) }, queryProps: { hours: { type: 'number', description: 'how far back, up to 168' }, size: { type: 'number', description: 'only this recorded size: 100, 1000 or 10000' } },
      pathParams: { ccy }, pathProps: { ccy: { type: 'string', description: '3-letter currency code, e.g. NGN' } }, routeTemplate: '/fx/:ccy/history', outputExample: HISTORY_EXAMPLE }
    : { url, description: `Executable ${ccy} rate per exchange at your trade size: effective rate, slippage, spread vs the official rate`, serviceName: SERVICE, tags: TAGS, iconUrl,
      queryParams: { size: num('size', 1000) }, queryProps: { size: { type: 'number', description: 'trade size in USD, 1 to 1,000,000 (default 1000)' } },
      pathParams: { ccy }, pathProps: { ccy: { type: 'string', description: '3-letter currency code, e.g. NGN, BRL, EUR, KES' } }, routeTemplate: '/fx/:ccy', outputExample: EXAMPLE }
}
function openapi(base: string, priceUsd: number | null, ctx: Ctx) {
  const pay = priceUsd ? { 'x-payment-info': { protocols: ['x402'], price: { mode: 'fixed', currency: 'USD', amount: String(priceUsd) } } } : {}
  const ccyParam = { name: 'ccy', in: 'path', required: true, schema: { type: 'string', enum: currencies(ctx).map((c) => c.ccy) }, description: '3-letter currency code' }
  const paid = (summary: string, extra: object[], example: object) => ({
    get: {
      summary, parameters: [ccyParam, ...extra], ...pay,
      responses: { 200: { description: 'OK', content: { 'application/json': { example } } }, ...(priceUsd ? { 402: { description: 'Payment required: x402, USDC on Base (PAYMENT-REQUIRED header; v1 challenge in the body)' } } : {}) },
    },
  })
  return {
    openapi: '3.1.0',
    info: {
      title: SERVICE, version: '1.0.0', description: `${DESCRIPTION} Computed from on-chain quotes and Textile RFQ previews; not bureau-de-change or parallel-market quotes.`,
      // API_CONTACT_EMAIL: shown publicly; x402scan uses it to verify ownership and let users reach you.
      ...(process.env.API_CONTACT_EMAIL ? { contact: { email: process.env.API_CONTACT_EMAIL } } : {}),
    },
    servers: [{ url: base }],
    paths: {
      '/fx': { get: { summary: 'Currencies covered, their official rate and where each trades (free)', security: [], responses: { 200: { description: 'OK' } } } }, // security: [] = free, not probed for a 402
      '/fx/{ccy}': paid('Executable rate per exchange at a trade size', [{ name: 'size', in: 'query', schema: { type: 'number', minimum: 1, maximum: 1_000_000, default: 1000 }, description: 'trade size in USD' }], EXAMPLE),
      '/fx/{ccy}/history': paid('Recorded rates per exchange', [{ name: 'hours', in: 'query', schema: { type: 'number', maximum: 168, default: 24 } }, { name: 'size', in: 'query', schema: { type: 'number', enum: RECORD_SIZES } }], HISTORY_EXAMPLE),
    },
    components: { securitySchemes: { apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key', description: 'for customers on a key instead of paying per call' } } },
  }
}
let PAY_WITH = 'USDC on Base' // set at start: 'USDC on Base, or USDT or USDC on Celo' when Celo payments are on
const llms = (base: string, priceUsd: number | null, ctx: Ctx) => `# ${SERVICE}

> ${DESCRIPTION}

Base URL: ${base}
${priceUsd ? `Price: $${priceUsd} per call in ${PAY_WITH}, paid with x402 (v2 PAYMENT-SIGNATURE or v1 X-PAYMENT). The 402 response says how.` : 'Free.'}

## Endpoints
- GET ${base}/fx : currencies covered (free). Now: ${currencies(ctx).map((c) => c.ccy).join(', ') || 'loading'}
- GET ${base}/fx/{CCY}?size=1000 : for buying and for selling {size} USD worth of the currency, per exchange: rate (currency units per USD), slippage against a $10 trade, spread against the official rate (bps), and the best exchange for each side
- GET ${base}/fx/{CCY}/history?hours=24&size=1000 : the recorded series
- ${base}/openapi.json, ${base}/.well-known/x402

## Notes
- Rates are what public contracts and Textile's makers would execute at, right now; nothing is reserved.
- For NGN and ARS the official rate differs from where crypto trades, so spreads against it are large and steady.
`
const landing = (base: string, priceUsd: number | null, ctx: Ctx) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${SERVICE}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:760px;margin:0 auto;padding:16px;background:#fff;color:#111}code,pre{background:#f3f3f3;border-radius:4px;padding:2px 4px}pre{padding:10px;overflow-x:auto}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}code,pre{background:#222}}</style></head><body>
<h1>${SERVICE}</h1><p>${DESCRIPTION}</p>
<p>${priceUsd ? `<b>$${priceUsd} per call</b>, paid by agents with <a href="https://www.x402.org">x402</a> (${PAY_WITH}). Teams can ask for an API key.` : 'Free.'}</p>
<pre>GET ${base}/fx/NGN?size=50000</pre>
<p>Currencies now: ${currencies(ctx).map((c) => `<code>${c.ccy}</code>`).join(' ') || 'loading'}</p>
<p><a href="/openapi.json">openapi.json</a> · <a href="/llms.txt">llms.txt</a> · <a href="/.well-known/x402">.well-known/x402</a> · <a href="/fx">/fx</a></p>
<p><small>On-chain execution data from public contracts and Textile RFQ previews, not bureau-de-change or parallel-market quotes.</small></p></body></html>`

// ERC-8004 agent registration file: the agentURI registered on Celo's Identity Registry, also served at
// /.well-known/agent-registration.json as the domain proof. ERC8004_AGENT_ID, once registered (npm run
// register-agent), adds the registration entry.
export const ERC8004_REGISTRY_CELO = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'
function agentRegistration(base: string, priceUsd: number | null) {
  const id = Number(process.env.ERC8004_AGENT_ID ?? '')
  return {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: SERVICE,
    description: `${DESCRIPTION}${priceUsd ? ` $${priceUsd} per call in ${PAY_WITH}, paid with x402.` : ''} Call GET ${base}/fx/{CCY}?size=1000; docs at ${base}/llms.txt.`,
    image: `${base}/icon.png`,
    services: [
      { name: 'web', endpoint: base },
      ...(process.env.API_CONTACT_EMAIL ? [{ name: 'email', endpoint: process.env.API_CONTACT_EMAIL }] : []),
    ],
    x402Support: !!priceUsd,
    active: true,
    registrations: Number.isInteger(id) && id > 0 ? [{ agentId: id, agentRegistry: `eip155:42220:${ERC8004_REGISTRY_CELO}` }] : [],
    supportedTrust: ['reputation'],
  }
}

// ---------- the server ----------
export function startFxApi(ctx: Ctx, port: number, say: (s: string) => void = console.log) {
  const keys = new Set((process.env.FX_API_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean))
  const pc = payConfig(() => hunterAccount().address)
  const pay = 'off' in pc ? null : pc
  if ('off' in pc && process.env.X402_PRICE_USD) say(`x402 payments OFF: ${pc.off}`)
  const cache = new Map<string, { at: number; body: FxQuote }>()
  const hits = new Map<string, number[]>() // ip -> request times (60 a minute)
  const send = (res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', ...headers })
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body, null, 1))
  }
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method === 'OPTIONS') return send(res, 204, '', { 'Access-Control-Allow-Methods': 'GET, OPTIONS' })
      const url = new URL(req.url ?? '/', 'http://x')
      const base = baseUrl(req)
      const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0]
      const recent = (hits.get(ip) ?? []).filter((t) => Date.now() - t < 60_000)
      if (recent.length >= 60) return send(res, 429, { error: 'rate limit: 60 requests a minute' })
      hits.set(ip, [...recent, Date.now()])
      const path = url.pathname.replace(/\/$/, '') || '/'
      // Free: the front door and the discovery documents.
      if (path === '/') return send(res, 200, landing(base, pay?.priceUsd ?? null, ctx), {}, 'text/html; charset=utf-8')
      if (path === '/health') return send(res, 200, { ok: true, chains: [...(ctx.fx?.keys() ?? [])], currencies: currencies(ctx).length })
      if (path === '/openapi.json') return send(res, 200, openapi(base, pay?.priceUsd ?? null, ctx))
      if (path === '/llms.txt') return send(res, 200, llms(base, pay?.priceUsd ?? null, ctx), {}, 'text/plain; charset=utf-8')
      if (path === '/.well-known/agent-registration.json' || path === '/agent-registration.json') return send(res, 200, agentRegistration(base, pay?.priceUsd ?? null))
      if (path === '/.well-known/x402' || path === '/.well-known/x402.json')
        return send(res, 200, { version: 1, resources: currencies(ctx).flatMap((c) => [`${base}/fx/${c.ccy}`, `${base}/fx/${c.ccy}/history`]), instructions: `GET /fx/{CCY}?size=USD. Docs: ${base}/llms.txt` })
      if ((path === '/icon.png' || path === '/favicon.ico') && existsSync('docs/brand/peg-hunter-favicon.png')) return send(res, 200, readFileSync('docs/brand/peg-hunter-favicon.png'), { 'Cache-Control': 'max-age=86400' }, 'image/png') // 64x64
      const parts = path.split('/').filter(Boolean)
      if (parts[0] !== 'fx' || parts.length > 3 || (parts.length === 3 && parts[2] !== 'history')) return send(res, 404, { error: 'not found; see /llms.txt' })
      if (parts.length === 1) return send(res, 200, { currencies: currencies(ctx), quote: `${base}/fx/{CCY}?size=1000`, history: `${base}/fx/{CCY}/history?hours=24`, docs: `${base}/llms.txt` })
      const ccy = parts[1].toUpperCase(), isHistory = parts[2] === 'history'
      // Paid routes: an API key, or an x402 payment (checked before anything else, so a bare probe gets the 402).
      const key = String(req.headers['x-api-key'] ?? '').trim() || String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim()
      let settle: (() => Promise<{ headers: Record<string, string> }>) | null = null
      if (!keys.has(key) && (keys.size || pay)) {
        if (!pay) return send(res, 401, { error: 'API key required (x-api-key)' })
        const ep = endpointFor(base, ccy, isHistory, `${base}${url.pathname}${url.search}`)
        if (!req.headers['payment-signature'] && !req.headers['x-payment']) { const ch = challenge(pay, ep, 'Payment required'); return send(res, 402, ch.body, ch.headers) }
        const r = await acceptPayment(pay, ep, req.headers)
        if (typeof r === 'string') { const ch = challenge(pay, ep, r); return send(res, 402, ch.body, ch.headers) }
        settle = r.settle
      }
      let body: unknown
      if (!/^[A-Z]{3}$/.test(ccy)) return send(res, 400, { error: 'currency must be a 3-letter code, e.g. NGN' })
      if (isHistory) body = { ccy, points: history(ccy, Math.min(168, Number(url.searchParams.get('hours') ?? '24')), Number(url.searchParams.get('size') ?? '0') || undefined) }
      else {
        const size = Number(url.searchParams.get('size') ?? '1000')
        if (!(size >= 1 && size <= 1_000_000)) return send(res, 400, { error: 'size must be between 1 and 1,000,000 (USD)' })
        if (!coinsOf(ctx, ccy).length) return send(res, 404, { error: `no ${ccy} coin on the chains served`, currencies: currencies(ctx).map((c) => c.ccy) })
        const k = `${ccy}:${size}`, hit = cache.get(k)
        if (hit && Date.now() - hit.at < CACHE_MS) body = hit.body
        else { const q = await fxQuote(ctx, ccy, size); cache.set(k, { at: Date.now(), body: q }); body = q }
      }
      // Paid call: the payment settles after the answer is ready and before it is sent (no settlement, no answer).
      if (settle) {
        const s = await settle().catch((e) => e as Error)
        if (s instanceof Error) { const ch = challenge(pay!, endpointFor(base, ccy, isHistory, `${base}${url.pathname}${url.search}`), s.message); return send(res, 402, ch.body, ch.headers) }
        return send(res, 200, body, { ...s.headers, 'Access-Control-Expose-Headers': 'PAYMENT-RESPONSE, X-PAYMENT-RESPONSE' })
      }
      return send(res, 200, body)
    } catch (e: any) { send(res, 500, { error: String(e?.shortMessage ?? e?.message ?? e).split('\n')[0] }) }
  })
  if (pay?.celo) PAY_WITH = 'USDC on Base, or USDT or USDC on Celo'
  server.listen(port, () => say(`FX API on port ${port} (${keys.size ? `${keys.size} API key(s)` : 'no keys'}${pay ? `, x402 $${pay.priceUsd} a call to ${pay.payTo} via ${pay.facilitator === 'self' ? 'self-settlement' : pay.facilitator}${pay.celo ? `; on Celo to ${pay.celo.payTo} via ${pay.celo.facilitator}` : ''}` : ''}${!keys.size && !pay ? ', open to all' : ''})`))
  // History: every FX_RECORD_MIN minutes (0 = off).
  const every = n('FX_RECORD_MIN', '5') * 60_000
  if (every > 0) (async () => {
    while (!ctx.stopping()) {
      await new Promise((r) => setTimeout(r, every))
      await recordOnce(ctx).catch((e) => say(`fx history: ${e?.message ?? e}`))
    }
  })()
  return server
}
