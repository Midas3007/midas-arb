// Kiyoshi trading loop. Dry run by default; LIVE=1 trades real money.
// Set PORT to also serve /health, /status and /trades (for Render and the dashboard).
//
// Each cycle: sell any leftover inventory (within the loss guard), discover which venues trade which tokens
// (every few hours), then scan every (token, buy venue, sell venue) route at its most profitable size and
// trade the best one if its profit after gas clears MIN_EDGE_USD.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { formatUnits, parseUnits } from 'viem'
import { ATTRIBUTION_TAG, CORRIDORS, CORRIDORS_FIXED, TOKENS, type TokenKey } from './config.js'
import { account, pub, lastTxBlock } from './wallet.js'
import { balanceOf } from './swap.js'
import { uniDiscover, uniQuote } from './uniswap.js'
import { mentoDiscover } from './mento.js'
import { ALL_VENUES, received, type Venue } from './venues.js'
import { buildRoutes, routeKey, routeName, scanRoutes, shouldSell, tradingAllowed, type Opp, type Route } from './engine.js'
import { PendingStore } from './pending.js'
import { notify } from './notify.js'
import { convertStats, handleConvert } from './convert.js'
import { flowSummary, netDeposits, updateFlows } from './flows.js'

const LIVE = process.env.LIVE === '1'
const MAX_TRADE_USD = Number(process.env.MAX_TRADE_USD ?? '70')
const MIN_TRADE_USD = Number(process.env.MIN_TRADE_USD ?? '2')
const MIN_EDGE_USD = Number(process.env.MIN_EDGE_USD ?? '0.02')          // profit after gas
const INTERVAL_MS = Number(process.env.INTERVAL_SEC ?? '20') * 1000
const MAX_FLATTEN_LOSS_BPS = Number(process.env.MAX_FLATTEN_LOSS_BPS ?? '50') // 0.5%
const MAX_HOLD_MS = Number(process.env.MAX_HOLD_MIN ?? '30') * 60_000
const MAX_DAILY_LOSS_USD = Number(process.env.MAX_DAILY_LOSS_USD ?? '5')
const REDISCOVER_MS = Number(process.env.REDISCOVER_HOURS ?? '6') * 3_600_000
const COOLDOWN_MS = Number(process.env.ROUTE_COOLDOWN_MIN ?? '5') * 60_000
const PORT = Number(process.env.PORT ?? 0)
const ONCE = process.env.ONCE === '1'
const SLIPPAGE_BPS = 30n // 0.3% on buy legs
const AGENT_ID = 9991
const DATA_DIR = process.env.DATA_DIR ?? '.'
const TRADES_FILE = DATA_DIR + '/trades.jsonl'
const STATE_FILE = DATA_DIR + '/state.json'
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

const usd = (v: bigint) => Number(formatUnits(v, 6))
const amt = (k: TokenKey, v: bigint) => Number(formatUnits(v, TOKENS[k].decimals))
const withSlippage = (v: bigint) => (v * (10_000n - SLIPPAGE_BPS)) / 10_000n
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const errMsg = (e: any) => String(e?.shortMessage ?? e?.message ?? e)

const pending = new PendingStore(DATA_DIR + '/pending.json')
let holdingInventory = false

// ---------- ledger ----------
type Entry = Record<string, any>
const fills: Entry[] = [] // cycles and flattens (no scans), served at /trades
if (existsSync(TRADES_FILE)) {
  for (const line of readFileSync(TRADES_FILE, 'utf8').split('\n')) {
    try { const e = JSON.parse(line); if (e.event === 'cycle' || e.event === 'flatten') fills.push(e) } catch {}
  }
}
function log(entry: Entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), live: LIVE, ...entry }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  appendFileSync(TRADES_FILE, line + '\n')
  const e = JSON.parse(line)
  if (e.event === 'cycle' || e.event === 'flatten') fills.push(e)
}
// Realized P&L today (UTC): completed cycles plus leftover sales measured against their cost.
function todayPnl() {
  const day = new Date().toISOString().slice(0, 10)
  return fills.filter((f) => f.live && String(f.ts).startsWith(day)).reduce((s, f) => {
    if (f.event === 'cycle' && typeof f.pnl === 'number') return s + f.pnl
    if (f.event === 'flatten' && typeof f.usdtOut === 'number' && typeof f.costUsdt === 'number') return s + f.usdtOut - f.costUsdt
    return s
  }, 0)
}

const status: Entry = {
  agent: { name: 'Kiyoshi', wallet: account.address, erc8004AgentId: AGENT_ID, attributionTag: ATTRIBUTION_TAG },
  live: LIVE, startedAt: new Date().toISOString(),
  config: { maxTradeUsd: MAX_TRADE_USD, minEdgeUsd: MIN_EDGE_USD, intervalSec: INTERVAL_MS / 1000, maxFlattenLossBps: MAX_FLATTEN_LOSS_BPS, maxHoldMin: MAX_HOLD_MS / 60_000, maxDailyLossUsd: MAX_DAILY_LOSS_USD },
  venues: ALL_VENUES.map((v) => v.name), routes: [], paused: false,
  lastScan: null, equity: null, baselineEquity: null, since: null, holding: false, lastError: null,
}
function summary() {
  const cycles = fills.filter((f) => f.event === 'cycle' && typeof f.pnl === 'number')
  return {
    ...status,
    pnl: status.equity !== null ? status.equity - status.baselineEquity : null,
    realizedPnl: cycles.reduce((s, f) => s + f.pnl, 0),
    todayPnl: todayPnl(),
    completedCycles: cycles.length,
    textileFills: fills.filter((f) => typeof f.textileUsd === 'number').length,
    convert: convertStats,
    textileVolumeUsd: fills.reduce((s, f) => s + (typeof f.textileUsd === 'number' ? f.textileUsd : 0), 0),
  }
}

// ---------- discovery ----------
// A venue "supports" X if a ~$5 round trip USDT -> X -> USDT can be quoted on it.
let routes: Route[] = []
let discoveredAt = 0
async function discover() {
  const tokens = [...new Set<TokenKey>([...CORRIDORS])]
  let [pools, mento] = await Promise.all([
    uniDiscover(tokens).catch((e) => { console.error('  uniswap discovery:', errMsg(e)); return 0 }),
    ALL_VENUES.some((v) => v.name === 'mento')
      ? mentoDiscover().catch((e) => { console.error('  mento discovery:', errMsg(e)); return { count: 0, added: [] as TokenKey[] } })
      : { count: 0, added: [] as TokenKey[] },
  ])
  // New Mento currencies join the scan (unless CORRIDORS is set), and Uniswap is checked for them too.
  const fresh = CORRIDORS_FIXED ? [] : mento.added.filter((k) => !tokens.includes(k))
  if (fresh.length) {
    console.log(`  new currencies from Mento: ${fresh.join(' ')}`)
    tokens.push(...fresh); CORRIDORS.push(...fresh)
    pools = await uniDiscover(tokens).catch(() => pools)
  }
  const supported = new Map<string, Set<TokenKey>>()
  await Promise.all(ALL_VENUES.map(async (v) => {
    const set = new Set<TokenKey>()
    await Promise.all(tokens.map(async (X) => {
      const got = await v.quote('USDT', X, 5_000_000n).catch(() => null)
      if (got && (await v.quote(X, 'USDT', got).catch(() => null))) set.add(X)
    }))
    supported.set(v.name, set)
  }))
  routes = buildRoutes(supported, ALL_VENUES)
  discoveredAt = Date.now()
  status.routes = routes.map(routeName)
  const per = ALL_VENUES.map((v) => `${v.name}: ${[...(supported.get(v.name) ?? [])].join(' ') || '-'}`).join(' | ')
  console.log(`  discovery: ${pools} uniswap pools, ${mento.count} mento exchanges, ${routes.length} routes`)
  console.log(`  ${per}`)
  log({ event: 'discovery', routes: status.routes })
}

// ---------- gas ----------
let celoUsd = 0, celoUsdAt = 0, gasPrice = 25_000_000_000n, gasPriceAt = 0 // gas price read at most every 15s, not once per route
async function gasUsd(units: number) {
  if (Date.now() - celoUsdAt > 10 * 60_000) {
    const q = await uniQuote('CELO', 'USDT', 10n ** 18n).catch(() => null)
    if (q) { celoUsd = usd(q.out); celoUsdAt = Date.now() }
  }
  if (Date.now() - gasPriceAt > 15_000) { gasPrice = await pub.getGasPrice().catch(() => gasPrice); gasPriceAt = Date.now() }
  const price = gasPrice
  return Number(formatUnits(price * BigInt(units), 18)) * celoUsd
}

// ---------- market helpers ----------
async function bestExit(X: TokenKey, amount: bigint): Promise<{ venue: Venue; out: bigint } | null> {
  const quotes = await Promise.all(ALL_VENUES.map(async (venue) => ({ venue, out: await venue.quote(X, 'USDT', amount).catch(() => null) })))
  let best: { venue: Venue; out: bigint } | null = null
  for (const q of quotes) if (q.out && (!best || q.out > best.out)) best = { venue: q.venue, out: q.out }
  return best
}

// Read every balance at ONE block that already includes our latest tx, so equity is a consistent snapshot.
async function snapshotBlock() {
  for (let i = 0; i < 20; i++) {
    const b = await pub.getBlockNumber({ cacheTime: 0 })
    if (b >= lastTxBlock) return b
    await sleep(1000)
  }
  throw new Error('RPC is lagging behind our last transaction; skipping equity read')
}
async function readAt(token: `0x${string}`, block: bigint) {
  for (let i = 0; ; i++) {
    try { return await balanceOf(token, block) } catch (e) { if (i >= 5) throw e; await sleep(1000) }
  }
}
const inventoryTokens = () => [...new Set<TokenKey>([...CORRIDORS, 'USDm'])].filter((k) => k !== 'USDT')
async function equity() {
  const block = await snapshotBlock()
  let total = usd(await readAt(TOKENS.USDT.address, block))
  for (const X of inventoryTokens()) {
    const bal = await readAt(TOKENS[X].address, block)
    if (bal === 0n) continue
    const exit = await bestExit(X, bal)
    if (exit) total += usd(exit.out)
  }
  return total
}

// Sell leftovers (half-finished cycles, or stray balances such as USDm from an interrupted Mento hop),
// unless that would lose more than the guard allows. Lots are stored on disk, so this survives restarts.
async function flatten() {
  holdingInventory = false
  for (const X of inventoryTokens()) {
    const bal = await balanceOf(TOKENS[X].address)
    if (bal === 0n) { pending.clear(X); continue }
    const exit = await bestExit(X, bal)
    if (!exit) { console.log(`  ${amt(X, bal).toFixed(4)} ${X} in wallet, but no venue will quote it right now (not counted in equity)`); continue }
    if (usd(exit.out) < 1) continue // dust, or below venue minimums

    let lot = pending.get(X)
    if (!lot) { pending.add(X, exit.out); lot = pending.get(X)! } // first sight of an unknown balance: start the clock at today's value
    const age = Date.now() - lot.since
    if (!shouldSell(exit.out, lot.costUsdt, age, MAX_FLATTEN_LOSS_BPS, MAX_HOLD_MS)) {
      console.log(`  holding ${amt(X, bal).toFixed(4)} ${X}: best exit $${usd(exit.out).toFixed(4)} vs cost $${usd(lot.costUsdt).toFixed(4)} (${Math.round(age / 60_000)}/${MAX_HOLD_MS / 60_000} min)`)
      holdingInventory = true
      continue
    }
    console.log(`  flatten: ${amt(X, bal).toFixed(4)} ${X} -> ~${usd(exit.out).toFixed(4)} USDT via ${exit.venue.name}`)
    if (!LIVE) continue
    try {
      const before = await balanceOf(TOKENS.USDT.address)
      const tx = await exit.venue.swap(X, 'USDT', bal, withSlippage(exit.out))
      const out = await received('USDT', before, tx)
      log({ event: 'flatten', X, venue: exit.venue.name, amountIn: bal, tx, usdtOut: usd(out), costUsdt: usd(lot.costUsdt), ...(exit.venue.name === 'textile' ? { textileUsd: usd(out) } : {}) })
      pending.clear(X)
      notify(`Kiyoshi: sold leftover ${X} for $${usd(out).toFixed(2)} (cost $${usd(lot.costUsdt).toFixed(2)})`)
    } catch (e) {
      console.error(`  flatten ${X} failed: ${errMsg(e)}`)
      holdingInventory = true
    }
  }
  status.holding = holdingInventory
}

// ---------- execution ----------
const cooldown = new Map<string, number>()

async function execute(o: Opp): Promise<number | null> {
  const { X, buy, sell } = o.route
  const name = routeName(o.route)
  // Leg 1: buy X. AMM legs revert below minOut; Textile refuses a firm quote below it.
  const xBefore = await balanceOf(TOKENS[X].address)
  let tx1
  try {
    tx1 = await buy.swap('USDT', X, o.size, withSlippage(o.mid))
  } catch (e) {
    cooldown.set(routeKey(o.route), Date.now() + COOLDOWN_MS)
    console.error(`  leg 1 (${buy.name} buy ${X}) failed: ${errMsg(e)}`)
    log({ event: 'cycle', route: name, X, sizeUsd: usd(o.size), leg1: errMsg(e), pnl: null })
    return null
  }
  const got = await received(X, xBefore, tx1)
  pending.add(X, o.size) // recorded before leg 2, so a crash or failure here keeps the loss guard
  // Leg 2: sell exactly what arrived, and never below what leg 1 cost (break-even floor).
  const usdtBefore = await balanceOf(TOKENS.USDT.address)
  try {
    const tx2 = await sell.swap(X, 'USDT', got, o.size + 1n)
    const out = await received('USDT', usdtBefore, tx2)
    pending.clear(X)
    const pnl = usd(out) - usd(o.size)
    log({ event: 'cycle', route: name, X, sizeUsd: usd(o.size), tx1, tx2, pnl, ...(buy.name === 'textile' || sell.name === 'textile' ? { textileUsd: usd(o.size) } : {}) })
    return pnl
  } catch (e) {
    cooldown.set(routeKey(o.route), Date.now() + COOLDOWN_MS)
    console.error(`  leg 2 (${sell.name} sell ${X}) failed: ${errMsg(e)}`)
    log({ event: 'cycle', route: name, X, sizeUsd: usd(o.size), tx1, leg2: errMsg(e), pnl: null })
    notify(`Kiyoshi: ${name} leg 2 failed (${errMsg(e).slice(0, 120)}). Holding ${amt(X, got).toFixed(4)} ${X}; the loss guard will sell it.`)
    return null
  }
}

async function cycle() {
  await flatten()
  if (holdingInventory) { console.log('  holding leftover inventory; no new trades until it is sold'); return }

  const pnlToday = todayPnl()
  status.paused = !tradingAllowed(pnlToday, MAX_DAILY_LOSS_USD)
  if (status.paused) { console.log(`  paused: today's loss $${(-pnlToday).toFixed(2)} reached MAX_DAILY_LOSS_USD`); return }

  if (Date.now() - discoveredAt > REDISCOVER_MS || !routes.length) await discover()
  const live = routes.filter((r) => (cooldown.get(routeKey(r)) ?? 0) < Date.now())

  const cash = await balanceOf(TOKENS.USDT.address)
  const cap = parseUnits(String(MAX_TRADE_USD), 6)
  const usable = (cash * 90n) / 100n
  const maxSize = LIVE ? (usable < cap ? usable : cap) : cap
  const minSize = parseUnits(String(MIN_TRADE_USD), 6)
  if (maxSize < minSize) { console.log(`  not enough USDT to trade (have ${usd(cash).toFixed(2)})`); return }

  const gasFor = new Map<string, number>()
  await Promise.all(live.map(async (r) => gasFor.set(routeKey(r), await gasUsd(r.buy.gas + r.sell.gas))))
  const opps = await scanRoutes(live, minSize, maxSize, (r) => gasFor.get(routeKey(r)) ?? 0)

  for (const o of opps.slice(0, 8)) console.log(`  ${routeName(o.route).padEnd(26)} $${usd(o.size).toFixed(2).padStart(7)} -> $${usd(o.out).toFixed(4)}  net ${o.net >= 0 ? '+' : ''}${o.net.toFixed(4)}`)
  status.lastScan = { at: new Date().toISOString(), maxSizeUsd: usd(maxSize), opps: opps.map((o) => ({ route: routeName(o.route), sizeUsd: usd(o.size), outUsd: usd(o.out), edge: o.edge, gasUsd: o.gasUsd, net: o.net })) }

  const best = opps[0]
  if (!best || best.net < MIN_EDGE_USD) { console.log(`  no trade: best net below $${MIN_EDGE_USD} (${live.length} routes)`); return }
  console.log(`  >> ${LIVE ? 'TRADING' : 'would trade'}: ${routeName(best.route)} at $${usd(best.size).toFixed(2)}, expected +$${best.net.toFixed(4)} after gas`)
  if (LIVE) {
    const pnl = await execute(best)
    console.log(`  result: ${pnl === null ? 'incomplete (leftover held and managed by flatten)' : (pnl >= 0 ? '+' : '') + pnl.toFixed(4) + ' USDT'}`)
  }
}

// ---------- web endpoint ----------
if (PORT) {
  createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end() }
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname.startsWith('/convert/')) { handleConvert(req, res, url); return }
    const json = (body: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body, null, 2)) }
    if (url.pathname === '/health') return res.end('ok')
    if (url.pathname === '/status') return json(summary())
    if (url.pathname === '/trades') {
      const n = Math.min(Number(url.searchParams.get('limit') ?? 100), 1000)
      return json(fills.slice(-n).reverse())
    }
    res.statusCode = 404
    res.end('not found')
  }).listen(PORT, () => console.log(`Serving /health /status /trades on port ${PORT}`))
}

// ---------- baseline for P&L ----------
let state: { baselineEquity: number; since: string }
if (process.env.BASELINE_EQUITY) {
  state = { baselineEquity: Number(process.env.BASELINE_EQUITY), since: process.env.BASELINE_SINCE ?? new Date().toISOString() }
} else if (existsSync(STATE_FILE)) {
  state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
} else {
  state = { baselineEquity: await equity(), since: new Date().toISOString() }
  if (LIVE) writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}
if (!Number.isFinite(state.baselineEquity)) throw new Error('BASELINE_EQUITY is not a plain number (no $ or commas)')
status.baselineEquity = state.baselineEquity
status.since = state.since

// ---------- safe shutdown (Render redeploys run old and new copies side by side briefly) ----------
let stopping = false
let inCycle = false
const stop = () => {
  stopping = true
  console.log('  stop requested' + (inCycle ? '; finishing the current cycle first' : ''))
  if (!inCycle) process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop) // Ctrl+C in Termux: never abandon a trade between its two legs
const STARTUP_DELAY_MS = Number(process.env.STARTUP_DELAY_SEC ?? (LIVE ? '10' : '0')) * 1000
if (STARTUP_DELAY_MS > 0) {
  console.log('Waiting ' + STARTUP_DELAY_MS / 1000 + 's before trading so any previous copy can finish and shut down')
  await sleep(STARTUP_DELAY_MS)
}

// ---------- main loop ----------
console.log(`Kiyoshi ${LIVE ? 'LIVE' : 'DRY RUN'} | wallet ${account.address} | venues ${status.venues.join(', ')} | max trade $${MAX_TRADE_USD} | min net $${MIN_EDGE_USD} | every ${INTERVAL_MS / 1000}s`)
if (LIVE) notify(`Kiyoshi started LIVE (max trade $${MAX_TRADE_USD})`)
let lastError = ''
while (true) {
  console.log(`\n[${new Date().toISOString()}]`)
  if (stopping) break
  inCycle = true
  try {
    await cycle()
    await updateFlows().catch((e: any) => console.error('  flows:', e.shortMessage ?? e.message))
    const net = netDeposits()
    if (Number.isFinite(net) && net > 0) { state.baselineEquity = net; status.baselineEquity = net }
    status.capital = flowSummary()
    const eq = await equity()
    status.equity = eq
    status.lastError = null
    console.log(`  equity $${eq.toFixed(4)}  P&L since ${state.since.slice(0, 10)}: ${eq - state.baselineEquity >= 0 ? '+' : ''}${(eq - state.baselineEquity).toFixed(4)}  today ${todayPnl() >= 0 ? '+' : ''}${todayPnl().toFixed(4)}`)
    log({ event: 'equity', equity: eq, pnl: eq - state.baselineEquity })
    lastError = ''
  } catch (e: any) {
    const msg = errMsg(e)
    console.error('  error:', msg)
    status.lastError = { at: new Date().toISOString(), message: msg }
    log({ event: 'error', message: msg })
    if (msg !== lastError) notify(`Kiyoshi error: ${msg.slice(0, 200)}`)
    lastError = msg
  }
  inCycle = false
  if (stopping) { console.log('  stopped cleanly between cycles'); process.exit(0) }
  if (ONCE && !PORT) break
  await sleep(INTERVAL_MS)
}
