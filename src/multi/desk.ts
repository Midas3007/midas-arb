// Multi-chain desk: USDT round trips between two Uniswap-v3-style exchanges on BSC and/or Polygon.
// Run one chain or several at once in one terminal:  npm run multi -- bsc   |   npm run multi -- bsc polygon
// Uses its OWN wallet (MULTI_PRIVATE_KEY) and its own switch (MULTI_LIVE=1); the Celo desk is never touched.
// Trading logic (routes, size search, loss guard, kill switch) is the same tested code as the Celo desk.
import 'dotenv/config'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import {
  concat, createPublicClient, createWalletClient, encodeFunctionData, encodePacked, erc20Abi, fallback, formatUnits,
  http, parseAbi, parseUnits, zeroAddress, type Address, type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { toDataSuffix } from '@celo/attribution-tags'
import { buildRoutes, routeKey, routeName, scanRoutes, shouldSell, tradingAllowed, usdOf, type Opp, type Route, type Venue } from '../engine.js'
import { PendingStore } from '../pending.js'
import { notify } from '../notify.js'
import { CHAINS, envDexes, type ChainProfile, type Dex } from './chains.js'
import { PoolWatcher } from '../watch.js'

const LIVE = process.env.MULTI_LIVE === '1'
const MAX_TRADE_USD = Number(process.env.MULTI_MAX_TRADE_USD ?? '20')
const MIN_TRADE_USD = Number(process.env.MULTI_MIN_TRADE_USD ?? '2')
const MIN_EDGE_USD = Number(process.env.MULTI_MIN_EDGE_USD ?? '0.02')
const INTERVAL_MS = Number(process.env.MULTI_INTERVAL_SEC ?? '20') * 1000
const MAX_DAILY_LOSS_USD = Number(process.env.MULTI_MAX_DAILY_LOSS_USD ?? '3')
const MAX_FLATTEN_LOSS_BPS = 50, MAX_HOLD_MS = 30 * 60_000, COOLDOWN_MS = 5 * 60_000, SLIPPAGE_BPS = 30n

const pk = process.env.MULTI_PRIVATE_KEY as Hex | undefined
if (!pk) throw new Error('Set MULTI_PRIVATE_KEY in .env (make one with: npm run new-wallet). Use a NEW wallet, not the Celo one.')
if (pk === process.env.AGENT_PRIVATE_KEY) throw new Error('MULTI_PRIVATE_KEY must be a different wallet from AGENT_PRIVATE_KEY.')
const account = privateKeyToAccount(pk)
const TAG = (process.env.ATTRIBUTION_TAG ? toDataSuffix(process.env.ATTRIBUTION_TAG) : '0x') as Hex

const factoryAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)'])
const quoterAbi = parseAbi(['function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[], uint32[], uint256)'])
const router02Abi = parseAbi(['function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256)'])
const routerV1Abi = parseAbi(['function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256)'])
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const errMsg = (e: any) => String(e?.shortMessage ?? e?.message ?? e).split('\n')[0]

async function runChain(p: ChainProfile) {
  const tag = `[${p.key}]`
  const say = (s: string) => console.log(`${tag} ${s}`)
  const transport = fallback(p.rpcs.map((u) => http(u, { timeout: 15_000, retryCount: 2 })))
  const pub = createPublicClient({ chain: p.chain, transport, batch: { multicall: true } })
  const wallet = createWalletClient({ account, chain: p.chain, transport })
  const dir = `data-${p.key}`
  if (!existsSync(dir)) mkdirSync(dir)
  const pending = new PendingStore(`${dir}/pending.json`)
  const log = (o: object) => appendFileSync(`${dir}/trades.jsonl`, JSON.stringify({ ts: new Date().toISOString(), chain: p.key, ...o }) + '\n')
  const T = p.tokens
  // The engine counts the cash token ("USDT") in 6 decimals ($1 = 1e6). BSC USDT has 18, so cash amounts are
  // scaled at the edge. Read at call time: the cash token can be switched on startup (<CHAIN>_CASH).
  const shift = () => T.USDT.decimals - 6
  const toRaw = (t: string, a: bigint) => (t !== 'USDT' ? a : shift() >= 0 ? a * 10n ** BigInt(shift()) : a / 10n ** BigInt(-shift()))
  const fromRaw = (t: string, a: bigint) => (t !== 'USDT' ? a : shift() >= 0 ? a / 10n ** BigInt(shift()) : a * 10n ** BigInt(-shift()))
  const usd = usdOf

  // ---------- chain access ----------
  let lastTxBlock = 0n
  async function send(to: Address, data: Hex) {
    const full = concat([data, TAG])
    for (let i = 0; ; i++) {
      try { await pub.call({ account, to, data: full }); break } catch (e) {
        if (i >= 4 || lastTxBlock === 0n) throw e
        await sleep(1500) // a load-balanced RPC node may not have seen our previous transaction yet
      }
    }
    const hash = await wallet.sendTransaction({ to, data: full })
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 })
    if (r.status !== 'success') throw new Error(`Transaction reverted: ${hash}`)
    if (r.blockNumber > lastTxBlock) lastTxBlock = r.blockNumber
    return r
  }
  const balanceOf = (t: string, blockNumber?: bigint) =>
    pub.readContract({ address: T[t].address, abi: erc20Abi, functionName: 'balanceOf', args: [account.address], ...(blockNumber ? { blockNumber } : {}) })
  async function ensureAllowance(t: string, spender: Address, need: bigint) {
    const have = await pub.readContract({ address: T[t].address, abi: erc20Abi, functionName: 'allowance', args: [account.address, spender] })
    if (have >= need) return
    const approve = (amt: bigint) => send(T[t].address, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amt] }))
    if (have > 0n) await approve(0n) // USDT-style tokens refuse a nonzero-to-nonzero change
    await approve(need * 4n)
    for (let i = 0; i < 10; i++) {
      const now = await pub.readContract({ address: T[t].address, abi: erc20Abi, functionName: 'allowance', args: [account.address, spender] }).catch(() => 0n)
      if (now >= need) return
      await sleep(1000)
    }
  }
  // What a swap actually delivered, read at its own block (in raw token units).
  async function received(t: string, before: bigint, block: bigint) {
    for (let i = 0; ; i++) {
      try { return (await balanceOf(t, block)) - before } catch (e) { if (i >= 10) throw e; await sleep(1000) }
    }
  }

  // ---------- exchanges ----------
  // A lane is one way through a single exchange: only its direct pool at one fee tier, or only paths through one
  // hub token. Pools of the same exchange drift apart (thin local-currency pools most of all), so buying in one
  // lane and selling in another is a trade even when only one exchange lists the currency.
  type Lane = { kind: 'all' } | { kind: 'fee'; fee: number } | { kind: 'hub'; hub: string }
  const pairKey = (a: string, b: string) => [a, b].sort().join(':')
  type DexVenue = Venue & { pools: Map<string, number[]>; addrs: Map<string, [string, string]>; discover(tokens: string[]): Promise<number> }
  function venueFor(d: Dex, pools = new Map<string, number[]>(), lane: Lane = { kind: 'all' }): DexVenue {
    // pools: "A:B" sorted -> fee tiers with a pool; shared by an exchange and its lanes
    const key = pairKey
    function paths(tin: string, tout: string): Hex[] {
      const out: Hex[] = []
      if (lane.kind !== 'hub') for (const f of pools.get(key(tin, tout)) ?? []) {
        if (lane.kind === 'fee' && f !== lane.fee) continue
        out.push(encodePacked(['address', 'uint24', 'address'], [T[tin].address, f, T[tout].address]))
      }
      if (lane.kind !== 'fee') for (const h of p.hubs) {
        if (h === tin || h === tout || (lane.kind === 'hub' && h !== lane.hub)) continue
        for (const f1 of pools.get(key(tin, h)) ?? []) for (const f2 of pools.get(key(h, tout)) ?? [])
          out.push(encodePacked(['address', 'uint24', 'address', 'uint24', 'address'], [T[tin].address, f1, T[h].address, f2, T[tout].address]))
      }
      return out
    }
    async function best(tin: string, tout: string, amt: bigint) {
      const raw = toRaw(tin, amt)
      const qs = await Promise.all(paths(tin, tout).map(async (path) => {
        try {
          const { result } = await pub.simulateContract({ address: d.quoter, abi: quoterAbi, functionName: 'quoteExactInput', args: [path, raw] })
          return { path, out: result[0] }
        } catch { return null }
      }))
      let b: { path: Hex; out: bigint } | null = null
      for (const q of qs) if (q && (!b || q.out > b.out)) b = q
      return b
    }
    const memo = new Map<string, { at: number; p: Promise<bigint | null> }>()
    const addrs = new Map<string, [string, string]>() // pool address -> its two tokens (for the watcher)
    return {
      name: lane.kind === 'all' ? d.name : lane.kind === 'fee' ? `${d.name}/${lane.fee / 10_000}%` : `${d.name}/via-${lane.hub}`,
      gas: lane.kind === 'hub' ? d.gas + 60_000 : d.gas,
      pools,
      addrs,
      async discover(tokens) {
        const all = [...new Set(['USDT', ...p.hubs, ...tokens])].filter((t) => T[t])
        const pairs: [string, string][] = []
        for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) pairs.push([all[i], all[j]])
        const res = await pub.multicall({
          allowFailure: true,
          contracts: pairs.flatMap(([a, b]) => d.fees.map((fee) => ({ address: d.factory, abi: factoryAbi, functionName: 'getPool', args: [T[a].address, T[b].address, fee] } as const))),
        })
        pools.clear()
        addrs.clear()
        res.forEach((r, i) => {
          if (r.status !== 'success' || r.result === zeroAddress) return
          const [a, b] = pairs[Math.floor(i / d.fees.length)]
          addrs.set(String(r.result).toLowerCase(), [a, b])
          pools.set(key(a, b), [...(pools.get(key(a, b)) ?? []), d.fees[i % d.fees.length]])
        })
        return pools.size
      },
      quote(tin, tout, amt) {
        const k = `${tin}>${tout}:${amt}`
        const hit = memo.get(k)
        if (hit && Date.now() - hit.at < 4000) return hit.p
        if (memo.size > 5000) memo.clear()
        const pr = best(tin, tout, amt).then((b) => (b ? fromRaw(tout, b.out) : null)).catch(() => null)
        memo.set(k, { at: Date.now(), p: pr })
        return pr
      },
      async swap(tin, tout, amt, minOut) {
        const raw = toRaw(tin, amt)
        const b = await best(tin, tout, amt)
        if (!b) throw new Error(`No ${d.name} route ${tin} -> ${tout}`)
        await ensureAllowance(tin, d.router, raw)
        const min = toRaw(tout, minOut)
        const data = d.routerStyle === '02'
          ? encodeFunctionData({ abi: router02Abi, functionName: 'exactInput', args: [{ path: b.path, recipient: account.address, amountIn: raw, amountOutMinimum: min }] })
          : encodeFunctionData({ abi: routerV1Abi, functionName: 'exactInput', args: [{ path: b.path, recipient: account.address, deadline: BigInt(Math.floor(Date.now() / 1000) + 300), amountIn: raw, amountOutMinimum: min }] })
        return (await send(d.router, data)).transactionHash
      },
    }
  }

  // Drop exchanges whose contracts are not on this chain (wrong address = no code).
  const venues: DexVenue[] = []
  const lanesOf = new Map<DexVenue, { lane: Lane; venue: DexVenue }[]>()
  try { await pub.getBlockNumber() } catch (e) { say(`cannot reach ${p.key} (${errMsg(e)}); set ${p.key.toUpperCase()}_RPCS in .env`); return }
  if (process.env.MULTI_MAJORS === '1') for (const m of p.majors) if (!p.corridors.includes(m)) p.corridors.push(m)
  // Check each gold / local-currency / RWA token: use it only if the address really is that token.
  const extraNames = Object.keys(p.extras).filter((k) => !T[k])
  const meta = await pub.multicall({
    allowFailure: true,
    contracts: extraNames.flatMap((k) => [
      { address: p.extras[k].address, abi: erc20Abi, functionName: 'symbol' } as const,
      { address: p.extras[k].address, abi: erc20Abi, functionName: 'decimals' } as const,
    ]),
  }).catch(() => [])
  const added: string[] = [], skipped: string[] = []
  extraNames.forEach((k, i) => {
    const sym = meta[2 * i], dec = meta[2 * i + 1]
    const ok = sym?.status === 'success' && dec?.status === 'success' && p.extras[k].expect.includes(String(sym.result).toUpperCase().replace(/[^A-Z0-9]/g, ''))
    if (!ok) { skipped.push(k); return }
    T[k] = { address: p.extras[k].address, decimals: Number(dec!.result) }
    if (!p.corridors.includes(k)) p.corridors.push(k)
    added.push(k)
  })
  if (added.length) say(`extra tokens: ${added.join(' ')}`)
  // <CHAIN>_CASH=USDC.n trades against another dollar token (the one an exchange's pools actually use).
  // The previous cash token becomes an ordinary tradable token.
  const cash = process.env[`${p.key.toUpperCase()}_CASH`]
  if (cash && cash !== 'USDT') {
    if (!T[cash]) { say(`${p.key.toUpperCase()}_CASH=${cash} is not a known token here; keeping the default`) } else {
      const oldKey = T.USDC ? 'CASH0' : 'USDC'
      T[oldKey] = T.USDT
      T.USDT = T[cash]
      delete T[cash]
      p.corridors = [...p.corridors.filter((k) => k !== cash), oldKey]
      p.hubs = p.hubs.map((h) => (h === cash ? oldKey : h))
      say(`cash token switched to ${cash} (shown as USDT); the default cash token is now traded as ${oldKey}`)
    }
  }
  if (skipped.length) say(`not found on ${p.key} (skipped): ${skipped.join(' ')}`)

  for (const d of [...p.dexes, ...envDexes(p.key)]) {
    const codes = await Promise.all([d.factory, d.quoter, d.router].map((a) => pub.getCode({ address: a }).catch(() => undefined)))
    if (codes.every((c) => c && c !== '0x')) {
      const v = venueFor(d)
      venues.push(v)
      const lanes: Lane[] = [...d.fees.map((fee) => ({ kind: 'fee', fee }) as Lane), ...p.hubs.map((hub) => ({ kind: 'hub', hub }) as Lane)]
      lanesOf.set(v, lanes.map((lane) => ({ lane, venue: venueFor(d, v.pools, lane) })))
    }
    else say(`skipping ${d.name}: contracts not found on ${p.key} (check the addresses in src/multi/chains.ts)`)
  }
  if (venues.length < 1) { say(`no exchanges configured${p.dexes.length ? ' or found' : ''}; add ${p.key.toUpperCase()}_DEXES to .env (see .env.example). Stopping this chain`); return }

  const watcher = new PoolWatcher(pub as any)

  // ---------- discovery, gas ----------
  let routes: Route[] = [], discoveredAt = 0
  async function discover() {
    const counts = await Promise.all(venues.map((v) => v.discover(p.corridors).catch((e) => { say(`${v.name} discovery: ${errMsg(e)}`); return 0 })))
    const supported = new Map<string, Set<string>>()
    await Promise.all(venues.map(async (v) => {
      const set = new Set<string>()
      await Promise.all(p.corridors.filter((X) => T[X]).map(async (X) => {
        const got = await v.quote('USDT', X, 5_000_000n)
        if (got && (await v.quote(X, 'USDT', got))) set.add(X)
      }))
      supported.set(v.name, set)
    }))
    // Cross-exchange routes, plus lane-to-lane routes inside each exchange (support read from the pool map).
    watcher.set(venues.flatMap((v) => [...v.addrs]))
    routes = buildRoutes(supported, venues)
    let inside = 0
    for (const v of venues) {
      const lanes = lanesOf.get(v) ?? []
      const laneSupport = new Map<string, Set<string>>()
      for (const { lane, venue } of lanes) {
        const set = new Set<string>()
        for (const X of p.corridors.filter((t) => T[t] && t !== 'USDT')) {
          if (lane.kind === 'fee' && v.pools.get(pairKey('USDT', X))?.includes(lane.fee)) set.add(X)
          if (lane.kind === 'hub' && lane.hub !== X && v.pools.get(pairKey('USDT', lane.hub))?.length && v.pools.get(pairKey(lane.hub, X))?.length) set.add(X)
        }
        laneSupport.set(venue.name, set)
      }
      const r = buildRoutes(laneSupport, lanes.map((l) => l.venue))
      inside += r.length
      routes.push(...r)
    }
    discoveredAt = Date.now()
    say(`discovery: ${venues.map((v, i) => `${v.name} ${counts[i]} pools`).join(', ')}, ${routes.length} routes (${inside} pool-to-pool)`)
    say(`  ${venues.map((v) => `${v.name}: ${[...(supported.get(v.name) ?? [])].join(' ') || '-'}`).join(' | ')}`)
    // An exchange with pools but no routes: show its pairs, so it is clear which token its pools trade against.
    const sym = new Map(Object.entries(T).map(([k, t]) => [k, k === 'USDT' ? 'cash' : k]))
    for (const v of venues) if (!supported.get(v.name)?.size && v.pools.size)
      say(`  ${v.name} has pools but none with the cash token: ${[...v.pools.keys()].map((k) => k.split(':').map((x) => sym.get(x) ?? x).join('/')).join(', ')}`)
  }
  let nativeUsd = 0, nativeAt = 0, gasPrice = 0n, gasAt = 0
  async function gasUsd(units: number) {
    if (Date.now() - nativeAt > 10 * 60_000) {
      const q = await venues[0].quote(p.native, 'USDT', 10n ** BigInt(T[p.native].decimals))
      if (q) { nativeUsd = usd(q); nativeAt = Date.now() }
    }
    if (Date.now() - gasAt > 15_000) { gasPrice = await pub.getGasPrice().catch(() => gasPrice); gasAt = Date.now() }
    return Number(formatUnits(gasPrice * BigInt(units), 18)) * nativeUsd
  }

  // ---------- inventory ----------
  async function bestExit(X: string, amount: bigint) {
    let b: { venue: Venue; out: bigint } | null = null
    for (const v of venues) { const out = await v.quote(X, 'USDT', amount); if (out && (!b || out > b.out)) b = { venue: v, out } }
    return b
  }
  let holding = false
  async function flatten() {
    holding = false
    for (const X of p.corridors.filter((t) => T[t] && t !== 'USDT')) {
      const bal = await balanceOf(X)
      if (bal === 0n) { pending.clear(X); continue }
      const exit = await bestExit(X, bal)
      if (!exit) { say(`  ${formatUnits(bal, T[X].decimals)} ${X} in wallet, no exchange will quote it right now`); continue }
      if (usd(exit.out) < 1) continue
      let lot = pending.get(X)
      if (!lot) { pending.add(X, exit.out); lot = pending.get(X)! }
      const age = Date.now() - lot.since
      if (!shouldSell(exit.out, lot.costUsdt, age, MAX_FLATTEN_LOSS_BPS, MAX_HOLD_MS)) {
        say(`  holding ${X}: exit $${usd(exit.out).toFixed(4)} vs cost $${usd(lot.costUsdt).toFixed(4)}`); holding = true; continue
      }
      say(`  flatten: ${X} -> ~$${usd(exit.out).toFixed(4)} via ${exit.venue.name}`)
      if (!LIVE) continue
      try {
        const before = await balanceOf('USDT')
        const h = await exit.venue.swap(X, 'USDT', bal, (exit.out * (10_000n - SLIPPAGE_BPS)) / 10_000n)
        const { blockNumber } = await pub.getTransactionReceipt({ hash: h })
        const out = fromRaw('USDT', await received('USDT', before, blockNumber))
        log({ event: 'flatten', X, usdtOut: usd(out), costUsdt: usd(lot.costUsdt) })
        realized += usd(out) - usd(lot.costUsdt)
        pending.clear(X)
      } catch (e) { say(`  flatten ${X} failed: ${errMsg(e)}`); holding = true }
    }
  }

  // ---------- execution ----------
  const today = () => new Date().toISOString().slice(0, 10)
  let realized = 0
  if (existsSync(`${dir}/trades.jsonl`)) for (const line of readFileSync(`${dir}/trades.jsonl`, 'utf8').split('\n')) {
    try { const t = JSON.parse(line); if (t.ts?.startsWith(today()) && typeof t.pnl === 'number') realized += t.pnl } catch { /* skip */ }
  }
  const cooldown = new Map<string, number>()
  async function execute(o: Opp) {
    const { X, buy, sell } = o.route
    const xBefore = await balanceOf(X)
    let h1: Hex
    try { h1 = await buy.swap('USDT', X, o.size, (o.mid * (10_000n - SLIPPAGE_BPS)) / 10_000n) } catch (e) {
      cooldown.set(routeKey(o.route), Date.now() + COOLDOWN_MS)
      say(`  leg 1 (${buy.name} buy ${X}) failed: ${errMsg(e)}`); log({ event: 'cycle', route: routeName(o.route), leg1: errMsg(e) }); return null
    }
    const r1 = await pub.getTransactionReceipt({ hash: h1 })
    const got = await received(X, xBefore, r1.blockNumber)
    pending.add(X, o.size)
    const uBefore = await balanceOf('USDT')
    try {
      const h2 = await sell.swap(X, 'USDT', got, o.size + 1n) // never below what leg 1 cost
      const r2 = await pub.getTransactionReceipt({ hash: h2 })
      const out = fromRaw('USDT', await received('USDT', uBefore, r2.blockNumber))
      pending.clear(X)
      const pnl = usd(out) - usd(o.size)
      realized += pnl
      log({ event: 'cycle', route: routeName(o.route), sizeUsd: usd(o.size), pnl, tx1: h1, tx2: h2 })
      return pnl
    } catch (e) {
      cooldown.set(routeKey(o.route), Date.now() + COOLDOWN_MS)
      say(`  leg 2 (${sell.name} sell ${X}) failed: ${errMsg(e)}`); log({ event: 'cycle', route: routeName(o.route), tx1: h1, leg2: errMsg(e) })
      notify(`${p.key}: ${routeName(o.route)} leg 2 failed; holding ${X}, the loss guard will sell it.`)
      return null
    }
  }

  // focus: tokens whose pools just traded (rescan only their routes; a hub token or null means everything).
  async function cycle(focus: Set<string> | null = null) {
    if (focus && [...focus].some((t) => p.hubs.includes(t))) focus = null
    await flatten()
    if (holding) { say('  holding leftover inventory; no new trades until it is sold'); return }
    if (!tradingAllowed(realized, MAX_DAILY_LOSS_USD)) { say(`  paused: today's loss reached $${MAX_DAILY_LOSS_USD}`); return }
    if (!routes.length || Date.now() - discoveredAt > 6 * 3_600_000) await discover()
    const live = routes.filter((r) => (cooldown.get(routeKey(r)) ?? 0) < Date.now() && (!focus || focus.has(r.X)))
    if (!live.length) return
    const cash = fromRaw('USDT', await balanceOf('USDT'))
    const cap = parseUnits(String(MAX_TRADE_USD), 6)
    const maxSize = LIVE ? ((cash * 90n) / 100n < cap ? (cash * 90n) / 100n : cap) : cap
    const minSize = parseUnits(String(MIN_TRADE_USD), 6)
    if (maxSize < minSize) { say(`  not enough USDT to trade (have $${usd(cash).toFixed(2)})`); return }
    const gas = new Map<string, number>()
    for (const r of live) gas.set(routeKey(r), await gasUsd(r.buy.gas + r.sell.gas))
    const opps = await scanRoutes(live, minSize, maxSize, (r) => gas.get(routeKey(r)) ?? 0)
    if (!focus) for (const o of opps.slice(0, 5)) say(`  ${routeName(o.route).padEnd(24)} $${usd(o.size).toFixed(2).padStart(6)} -> $${usd(o.out).toFixed(4)}  net ${o.net >= 0 ? '+' : ''}${o.net.toFixed(4)}`)
    const best = opps[0]
    // Every scan's best route is saved (dry run and live) so npm run multi-stats can show how close gaps came.
    if (best) appendFileSync(`${dir}/scans.jsonl`, JSON.stringify({ ts: new Date().toISOString(), route: routeName(best.route), sizeUsd: usd(best.size), net: best.net, would: best.net >= MIN_EDGE_USD, live: LIVE }) + '\n')
    if (focus && (!best || best.net < MIN_EDGE_USD)) return // a quick rescan after a trade: stay quiet unless it pays
    if (!best || best.net < MIN_EDGE_USD) { say(`  no trade (${live.length} routes)  USDT $${usd(cash).toFixed(2)}  today ${realized >= 0 ? '+' : ''}${realized.toFixed(4)}`); return }
    say(`  >> ${LIVE ? 'TRADING' : 'would trade'}: ${routeName(best.route)} $${usd(best.size).toFixed(2)}, expected +$${best.net.toFixed(4)}`)
    if (LIVE) { const pnl = await execute(best); say(`  result: ${pnl === null ? 'incomplete (leftover managed by flatten)' : (pnl >= 0 ? '+' : '') + pnl.toFixed(4)}`) }
  }

  say(`${LIVE ? 'LIVE' : 'DRY RUN'}${['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', '0xe15fc38f6d8c56af07bbcbe3baf5708a2bf42392'].includes(T.USDT.address.toLowerCase()) ? ' | cash token: USDC (shown as USDT)' : ''} | wallet ${account.address} | ${venues.map((v) => v.name).join(' + ')} | max $${MAX_TRADE_USD}`)
  // Full scan every INTERVAL; in between, rescan as soon as a watched pool trades.
  let focus: Set<string> | null = null, lastFull = 0, quick = 0
  while (!stopping) {
    if (!focus) lastFull = Date.now()
    inCycle++
    try { await cycle(focus) } catch (e) { say(`cycle error: ${errMsg(e)}`) }
    inCycle--
    if (stopping) break
    if (!focus) { say(`  watching ${watcher.size} pools; ${quick} quick rescans since the last full scan`); quick = 0 }
    focus = await watcher.wait(Math.max(0, lastFull + INTERVAL_MS - Date.now()), () => stopping)
    if (focus) quick++
  }
}

// Ctrl+C: let any chain finish the trade it is in, then exit.
let stopping = false, inCycle = 0
process.on('SIGINT', () => {
  stopping = true
  console.log('stop requested' + (inCycle ? '; finishing current trades first' : ''))
  if (!inCycle) process.exit(0)
  const t = setInterval(() => { if (!inCycle) { clearInterval(t); process.exit(0) } }, 500)
})

const wanted = process.argv.slice(2).map((s) => s.toLowerCase())
const chosen = (wanted.length ? wanted : (process.env.MULTI_CHAINS ?? 'bsc').split(',')).map((s) => s.trim())
const unknown = chosen.filter((c) => !CHAINS[c])
if (unknown.length) { console.error(`Unknown chain(s): ${unknown.join(', ')}. Available: ${Object.keys(CHAINS).join(', ')}`); process.exit(1) }
await Promise.all(chosen.map((c) => runChain(CHAINS[c]).catch((e) => console.error(`[${c}] stopped: ${errMsg(e)}`))))
