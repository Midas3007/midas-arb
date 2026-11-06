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
//   X402_PRICE_USD=0.005        everyone else pays per call with x402 (HTTP 402, USDC on Base, EIP-3009). The server
//                               checks the signed authorization itself and settles it on-chain from the bot wallet
//                               (it pays the ~$0.002 gas), so no facilitator account is needed. X402_PAY_TO: where the
//                               USDC goes (default: the bot wallet).
//   neither set                 open (for running it on your own machine)
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { erc20Abi, parseAbi, parseSignature, verifyTypedData, type Address, type Hex } from 'viem'
import { DATA_DIR } from '../config.js'
import { CHAINS } from './chains.js'
import { clientsFor, hunterAccount } from './clients.js'
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

// ---------- x402: pay per call in USDC on Base (exact scheme, EIP-3009), settled by this server ----------
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address
const usdcAbi = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
])
const authTypes = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
] } as const
const usedNonces = new Set<string>()

function x402Requirements(resource: string) {
  const price = BigInt(Math.round(n('X402_PRICE_USD', '0') * 1e6))
  return {
    scheme: 'exact', network: 'base', maxAmountRequired: price.toString(), resource, description: 'FX execution quote (per call)',
    mimeType: 'application/json', payTo: (process.env.X402_PAY_TO || hunterAccount().address) as Address, maxTimeoutSeconds: 120,
    asset: USDC_BASE, extra: { name: 'USD Coin', version: '2' },
  }
}
// Checks the payment header; returns a function that settles it on-chain, or an error message.
async function checkPayment(header: string, req: ReturnType<typeof x402Requirements>): Promise<{ settle: () => Promise<Hex>; payer: Address } | string> {
  let p: any
  try { p = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) } catch { return 'X-PAYMENT is not base64 JSON' }
  if (p?.scheme !== 'exact' || p?.network !== 'base') return 'only the exact scheme on base is accepted'
  const a = p.payload?.authorization, sig = p.payload?.signature as Hex
  if (!a || !sig) return 'missing authorization or signature'
  const now = Math.floor(Date.now() / 1000)
  if (String(a.to).toLowerCase() !== req.payTo.toLowerCase()) return 'payment goes to the wrong address'
  if (BigInt(a.value) < BigInt(req.maxAmountRequired)) return 'payment too small'
  if (Number(a.validAfter) > now || Number(a.validBefore) < now + 6) return 'authorization not valid now'
  if (usedNonces.has(String(a.nonce).toLowerCase())) return 'nonce already used'
  const message = { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce }
  const ok = await verifyTypedData({ address: a.from, domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC_BASE }, types: authTypes, primaryType: 'TransferWithAuthorization', message, signature: sig }).catch(() => false)
  if (!ok) return 'bad signature'
  const c = clientsFor(CHAINS.base)
  const [used, bal] = await Promise.all([
    c.pub.readContract({ address: USDC_BASE, abi: usdcAbi, functionName: 'authorizationState', args: [a.from, a.nonce] }),
    c.pub.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: 'balanceOf', args: [a.from] }),
  ])
  if (used) return 'nonce already used'
  if (bal < BigInt(a.value)) return 'payer has too little USDC'
  usedNonces.add(String(a.nonce).toLowerCase())
  const { r, s, v, yParity } = parseSignature(sig)
  const args = [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, Number(v ?? BigInt(27 + (yParity ?? 0))), r, s] as const
  return {
    payer: a.from,
    settle: async () => {
      const { request } = await c.pub.simulateContract({ account: c.account, address: USDC_BASE, abi: usdcAbi, functionName: 'transferWithAuthorization', args })
      const hash = await c.wallet.writeContract(request as any)
      await c.pub.waitForTransactionReceipt({ hash, timeout: 60_000 })
      return hash
    },
  }
}

// ---------- the server ----------
export function startFxApi(ctx: Ctx, port: number, say: (s: string) => void = console.log) {
  const keys = new Set((process.env.FX_API_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean))
  const paid = n('X402_PRICE_USD', '0') > 0
  const cache = new Map<string, { at: number; body: FxQuote }>()
  const hits = new Map<string, number[]>() // ip -> request times (60 a minute)
  const json = (res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...headers })
    res.end(JSON.stringify(body, null, 1))
  }
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0]
      const recent = (hits.get(ip) ?? []).filter((t) => Date.now() - t < 60_000)
      if (recent.length >= 60) return json(res, 429, { error: 'rate limit: 60 requests a minute' })
      hits.set(ip, [...recent, Date.now()])
      const parts = url.pathname.split('/').filter(Boolean)
      if (url.pathname === '/health') return json(res, 200, { ok: true, chains: [...(ctx.fx?.keys() ?? [])] })
      if (parts[0] !== 'fx') return json(res, 404, { error: 'see /fx' })
      // Access: an API key, or an x402 payment, or open when neither is configured.
      const key = String(req.headers['x-api-key'] ?? '').trim() || String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim()
      let settle: (() => Promise<Hex>) | null = null
      if (parts.length > 1 && !keys.has(key) && (keys.size || paid)) {
        if (!paid) return json(res, 401, { error: 'API key required (x-api-key)' })
        const reqs = x402Requirements(url.toString())
        const header = String(req.headers['x-payment'] ?? '')
        if (!header) return json(res, 402, { x402Version: 1, error: 'X-PAYMENT header is required', accepts: [reqs] })
        const r = await checkPayment(header, reqs)
        if (typeof r === 'string') return json(res, 402, { x402Version: 1, error: r, accepts: [reqs] })
        settle = r.settle
      }
      let body: unknown
      if (parts.length === 1) body = { currencies: currencies(ctx), sizes: 'any; ?size=USD amount', history: 'GET /fx/<CCY>/history?hours=24&size=1000' }
      else {
        const ccy = parts[1].toUpperCase()
        if (!/^[A-Z]{3}$/.test(ccy)) return json(res, 400, { error: 'currency must be a 3-letter code, e.g. NGN' })
        if (parts[2] === 'history') body = { ccy, points: history(ccy, Math.min(168, Number(url.searchParams.get('hours') ?? '24')), Number(url.searchParams.get('size') ?? '0') || undefined) }
        else {
          const size = Number(url.searchParams.get('size') ?? '1000')
          if (!(size >= 1 && size <= 1_000_000)) return json(res, 400, { error: 'size must be between 1 and 1,000,000 (USD)' })
          if (!coinsOf(ctx, ccy).length) return json(res, 404, { error: `no ${ccy} coin on the chains served`, currencies: currencies(ctx).map((c) => c.ccy) })
          const k = `${ccy}:${size}`, hit = cache.get(k)
          body = hit && Date.now() - hit.at < CACHE_MS ? hit.body : (await fxQuote(ctx, ccy, size))
          if (!hit || Date.now() - hit.at >= CACHE_MS) cache.set(k, { at: Date.now(), body: body as FxQuote })
        }
      }
      if (settle) { // paid call: settle first, then answer (the receipt goes back in X-PAYMENT-RESPONSE)
        const tx = await settle()
        return json(res, 200, body, { 'X-PAYMENT-RESPONSE': Buffer.from(JSON.stringify({ success: true, transaction: tx, network: 'base' })).toString('base64') })
      }
      return json(res, 200, body)
    } catch (e: any) { json(res, 500, { error: String(e?.shortMessage ?? e?.message ?? e).split('\n')[0] }) }
  })
  server.listen(port, () => say(`FX API on port ${port}: /fx, /fx/NGN?size=1000, /fx/NGN/history (${keys.size ? `${keys.size} API key(s)` : 'no keys'}${paid ? `, x402 $${process.env.X402_PRICE_USD} a call` : ''}${!keys.size && !paid ? ', open' : ''})`))
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
