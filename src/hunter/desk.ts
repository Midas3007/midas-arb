// One chain's trading desk. Finds pools where a currency-pegged stablecoin trades away from its real exchange
// rate, buys the cheap side there and sells it straight away on the same chain through a deep pool (or Mento on
// Celo). Both legs on one chain: no bridging, gas costs a fraction of a cent.
//
// Every candidate trade passes, in order: a quoted profit after gas and fees (round trip, measured in dollars),
// an exit-pool size limit, a fair price from two agreeing sources, the depeg / stuck-pool / suspicious-price
// guards, and the minimum gap. Then a pre-send simulation of each transaction.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import {
  concat, encodeFunctionData, encodePacked, erc20Abi, formatUnits, parseAbi, parseAbiItem, parseUnits, zeroAddress,
  type Address, type Hex,
} from 'viem'
import { toDataSuffix } from '@celo/attribution-tags'
import { buildRoutes, prefilterRoutes, routeKey, routeName, scanRoutes, shouldSell, tradingAllowed, usdOf, type Opp, type Route, type Venue } from '../engine.js'
import { PendingStore } from '../pending.js'
import { notify } from '../notify.js'
import { PoolWatcher } from '../watch.js'
import { cheapFees } from '../fees.js'
import { ATTRIBUTION_TAG, DATA_DIR } from '../config.js'
import { envDexes, type ChainProfile, type Dex } from './chains.js'
import { clientsFor } from './clients.js'
import { mentoVenue } from './mento.js'
import { bestOf, hopVenue } from './hop.js'
import { solidlyVenue } from './solidly.js'
import { curveVenue } from './curve.js'
import { v4Venue, V4_TIERS } from './v4.js'
import { limiter } from './limit.js'
import { inflight } from './inflight.js'
import { aaveInfo, aaveWithdraw, parkedUnits } from './savings.js'
import { textileVenue } from './textile.js'
import { blockReason, maxTradeUsd, poolDev, RULES, type PegBoard } from './peg.js'
import type { FairPrices } from './fair.js'
import type { Ledger, Locks, Store } from './store.js'

export type ChainStatus = {
  started: boolean; gasOk: boolean; swapGasUsd: number; cashUsd: number; routes: number; tokens: string[]
  parkedUsd: number; apyPct: number // cash earning interest in Aave, and its rate
  lastScanAt: number; lastLine: string; error?: string
}
export type Ctx = {
  store: Store; ledger: Ledger; fair: FairPrices; board: PegBoard; locks: Locks
  live: boolean // HUNTER_LIVE=1
  status: Map<string, ChainStatus>
  stopping: () => boolean
}

const n = (k: string, d: string) => Number(process.env[k] ?? d)
const MIN_TRADE_USD = n('MIN_TRADE_USD', '0.5')
const WATCH_CAPITAL_USD = n('WATCH_CAPITAL_USD', process.env.WATCH_SIZE_USD ?? '218') // watch mode: size trades as if the chain held this much
const INTERVAL_MS = n('INTERVAL_SEC', '20') * 1000
const MAX_DAILY_LOSS_USD = n('MAX_DAILY_LOSS_USD', '3') // per chain
const GLOBAL_DAILY_LOSS_USD = n('GLOBAL_DAILY_LOSS_USD', '5') // all chains together
const MAX_SWAP_GAS_USD = n('MAX_SWAP_GAS_USD', '0.01')
const MAX_EXIT_IMPACT_BPS = n('MAX_EXIT_IMPACT_BPS', '100')
const ALERT_TRADE_USD = n('ALERT_TRADE_USD', '1')
const NEWPOOL_MS = n('NEWPOOL_SEC', '60') * 1000
const OBSERVE_MS = n('OBSERVE_SEC', '300') * 1000
const PREFILTER_FROM = n('PREFILTER_FROM', '60') // chains with more routes than this are prefiltered
const MAX_FLATTEN_LOSS_BPS = 50, MAX_HOLD_MS = 30 * 60_000, COOLDOWN_MS = 5 * 60_000, SLIPPAGE_BPS = 30n
const MODE = process.argv.includes('--scan') ? 'scan' : process.argv.includes('--watch') ? 'watch' : (process.env.MODE ?? 'both')

const factoryAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)'])
const slipFactoryAbi = parseAbi(['function getPool(address,address,int24) view returns (address)']) // keyed by tick spacing
const quoterAbi = parseAbi(['function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[], uint32[], uint256)'])
const router02Abi = parseAbi(['function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256)'])
const routerV1Abi = parseAbi(['function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256)'])
const poolCreated = parseAbiItem('event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)')
const slipPoolCreated = parseAbiItem('event PoolCreated(address indexed token0, address indexed token1, int24 indexed tickSpacing, address pool)')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const errMsg = (e: any) => String(e?.shortMessage ?? e?.message ?? e).split('\n')[0]
const pct = (d: number | null) => (d === null ? '?' : `${d >= 0 ? '+' : ''}${(d * 100).toFixed(2)}%`)

type DexVenue = Venue & { pools: Map<string, number[]>; addrs: Map<string, string[]>; discover(tokens: string[]): Promise<number>; hubTier?: Map<string, number> }
// A lane is one way through an exchange: one direct pool (fee), or through a hub with the coin's side pinned to one
// pool (hubfee). The cash <-> hub step always uses that pair's deepest pool (picked at discovery).
type Lane = { kind: 'all' } | { kind: 'fee'; fee: number } | { kind: 'hubfee'; hub: string; fee: number }

export async function runChain(p: ChainProfile, ctx: Ctx) {
  const tag = `[${p.key}]`
  const say = (s: string) => console.log(`${tag} ${s}`)
  const { pub, wallet, account } = clientsFor(p)
  const status: ChainStatus = { started: false, gasOk: false, swapGasUsd: 0, cashUsd: 0, parkedUsd: 0, apyPct: 0, routes: 0, tokens: [], lastScanAt: 0, lastLine: 'starting' }
  ctx.status.set(p.key, status)
  const dir = `${DATA_DIR}/${p.key}`
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const pending = new PendingStore(`${dir}/pending.json`)
  const log = (file: string, o: object) => appendFileSync(`${dir}/${file}`, JSON.stringify({ ts: new Date().toISOString(), chain: p.key, ...o }) + '\n')
  const TAG = (p.key === 'celo' && ATTRIBUTION_TAG ? toDataSuffix(ATTRIBUTION_TAG) : '0x') as Hex
  const T = p.tokens
  const rpc = limiter(Number(process.env[`${p.key.toUpperCase()}_RPC_CONCURRENCY`] ?? process.env.RPC_CONCURRENCY ?? p.rpcConcurrency ?? 8)) // quotes in flight at once on this chain
  const st = () => ctx.store.state.chains[p.key]
  // The engine counts the cash token in 6 decimals ($1 = 1e6); cash tokens with other decimals are scaled here.
  const shift = () => T.USDT.decimals - 6
  const toRaw = (t: string, a: bigint) => (t !== 'USDT' ? a : shift() >= 0 ? a * 10n ** BigInt(shift()) : a / 10n ** BigInt(-shift()))
  const fromRaw = (t: string, a: bigint) => (t !== 'USDT' ? a : shift() >= 0 ? a / 10n ** BigInt(shift()) : a * 10n ** BigInt(-shift()))
  const usd = usdOf

  // ---------- chain access ----------
  let lastTxBlock = 0n
  let spentNative = 0n // gas paid by this chain's current trade (all its transactions, approvals included)
  async function send(to: Address, data: Hex) {
    const full = concat([data, TAG])
    for (let i = 0; ; i++) { // simulate first: a transaction that would revert is never sent, so costs nothing
      try { await pub.call({ account, to, data: full }); break } catch (e) {
        if (i >= 4 || lastTxBlock === 0n) throw e
        await sleep(1500) // a load-balanced RPC node may not have seen our previous transaction yet
      }
    }
    const fees = await cheapFees(pub as any, { account: account.address, to, data: full }).catch(() => ({}))
    const hash = await wallet.sendTransaction({ account, chain: p.chain, to, data: full, ...fees } as any)
    const r: any = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 })
    spentNative += BigInt(r.gasUsed ?? 0n) * BigInt(r.effectiveGasPrice ?? 0n) + BigInt(r.l1Fee ?? 0n)
    if (r.status !== 'success') throw new Error(`Transaction reverted: ${hash}`)
    if (r.blockNumber > lastTxBlock) lastTxBlock = r.blockNumber
    return r as { transactionHash: Hex; blockNumber: bigint }
  }
  const balanceOf = (t: string, blockNumber?: bigint) =>
    pub.readContract({ address: T[t].address, abi: erc20Abi, functionName: 'balanceOf', args: [account.address], ...(blockNumber ? { blockNumber } : {}) })
  async function ensureAllowance(t: string, spender: Address, need: bigint) {
    const have = await pub.readContract({ address: T[t].address, abi: erc20Abi, functionName: 'allowance', args: [account.address, spender] })
    if (have >= need) return
    const approve = (amt: bigint) => send(T[t].address, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amt] }))
    if (have > 0n) await approve(0n) // USDT-style tokens refuse a nonzero-to-nonzero change
    await approve(need * 4n) // capped: 4 trades' worth, never unlimited
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
  const pairKey = (a: string, b: string) => [a, b].sort().join(':')
  function venueFor(d: Dex, pools = new Map<string, number[]>(), lane: Lane = { kind: 'all' }, hubTier = new Map<string, number>()): DexVenue {
    // Fee tiers to try for one leg: the cash <-> hub leg uses its deepest pool only; in a hubfee lane the coin's
    // leg uses the lane's pool only.
    const legFees = (a: string, b: string): number[] => {
      const fs = pools.get(pairKey(a, b)) ?? []
      const hub = a === 'USDT' ? b : b === 'USDT' ? a : null
      if (hub && p.hubs.includes(hub)) { const t = hubTier.get(hub); return t !== undefined && fs.includes(t) ? [t] : fs }
      if (lane.kind === 'hubfee' && (a === lane.hub || b === lane.hub)) return fs.filter((f) => f === lane.fee)
      return fs
    }
    function paths(tin: string, tout: string): Hex[] {
      const out: Hex[] = []
      if (lane.kind !== 'hubfee') for (const f of pools.get(pairKey(tin, tout)) ?? []) {
        if (lane.kind === 'fee' && f !== lane.fee) continue
        out.push(encodePacked(['address', 'uint24', 'address'], [T[tin].address, f, T[tout].address]))
      }
      if (lane.kind !== 'fee') for (const h of p.hubs) {
        if (!T[h] || h === tin || h === tout || (lane.kind === 'hubfee' && h !== lane.hub)) continue
        for (const f1 of legFees(tin, h)) for (const f2 of legFees(h, tout))
          out.push(encodePacked(['address', 'uint24', 'address', 'uint24', 'address'], [T[tin].address, f1, T[h].address, f2, T[tout].address]))
      }
      return out
    }
    async function best(tin: string, tout: string, amt: bigint) {
      const raw = toRaw(tin, amt)
      const qs = await Promise.all(paths(tin, tout).map(async (path) => {
        try {
          const { result } = await rpc(() => pub.simulateContract({ address: d.quoter, abi: quoterAbi, functionName: 'quoteExactInput', args: [path, raw] }))
          return { path, out: result[0] }
        } catch { return null }
      }))
      let b: { path: Hex; out: bigint } | null = null
      for (const q of qs) if (q && (!b || q.out > b.out)) b = q
      return b
    }
    const memo = new Map<string, { at: number; p: Promise<bigint | null> }>()
    const addrs = new Map<string, string[]>() // pool address -> its two tokens (for the watcher)
    return {
      name: lane.kind === 'all' ? d.name : (d.kind === 'slipstream' ? `${d.name}/ts${lane.fee}` : `${d.name}/${lane.fee / 10_000}%`) + (lane.kind === 'hubfee' ? `-via-${lane.hub}` : ''),
      gas: lane.kind === 'hubfee' ? d.gas + 60_000 : d.gas,
      pools,
      hubTier,
      addrs,
      async discover(tokens) {
        // Only pairs with the cash token or a hub: those are the only pools a route can use (and with 200+ stock
        // tokens, every pair would be 80,000 lookups).
        const bases = ['USDT', ...p.hubs].filter((t) => T[t])
        const all = [...new Set([...bases, ...tokens])].filter((t) => T[t])
        const pairs: [string, string][] = []
        for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) if (bases.includes(all[i]) || bases.includes(all[j])) pairs.push([all[i], all[j]])
        const res = await pub.multicall({
          allowFailure: true,
          contracts: pairs.flatMap(([a, b]) => d.fees.map((fee) => ({ address: d.factory, abi: (d.kind === 'slipstream' ? slipFactoryAbi : factoryAbi) as typeof factoryAbi, functionName: 'getPool', args: [T[a].address, T[b].address, fee] } as const))),
        })
        pools.clear(); addrs.clear()
        res.forEach((r, i) => {
          if (r.status !== 'success' || r.result === zeroAddress) return
          const [a, b] = pairs[Math.floor(i / d.fees.length)]
          addrs.set(String(r.result).toLowerCase(), [a, b])
          pools.set(pairKey(a, b), [...(pools.get(pairKey(a, b)) ?? []), d.fees[i % d.fees.length]])
        })
        // The deepest cash <-> hub pool: the one that gives the most for $100.
        hubTier.clear()
        await Promise.all(p.hubs.filter((h) => T[h]).map(async (h) => {
          let bestFee: number | undefined, bestOut = 0n
          for (const f of pools.get(pairKey('USDT', h)) ?? []) {
            try {
              const path = encodePacked(['address', 'uint24', 'address'], [T.USDT.address, f, T[h].address])
              const { result } = await rpc(() => pub.simulateContract({ address: d.quoter, abi: quoterAbi, functionName: 'quoteExactInput', args: [path, toRaw('USDT', 100_000_000n)] }))
              if (result[0] > bestOut) { bestOut = result[0]; bestFee = f }
            } catch { /* empty pool */ }
          }
          if (bestFee !== undefined) hubTier.set(h, bestFee)
        }))
        return pools.size
      },
      quote(tin, tout, amt) {
        const k = `${tin}>${tout}:${amt}`, hit = memo.get(k)
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

  // ---------- startup: connection, tokens, exchanges ----------
  for (let tries = 0; ; tries++) {
    try { await pub.getBlockNumber(); break } catch (e) {
      status.error = `cannot reach ${p.key} (${errMsg(e)}); set ${p.key.toUpperCase()}_RPCS in .env`
      if (tries === 0) say(status.error)
      if (ctx.stopping()) return
      await sleep(60_000)
    }
  }
  status.error = undefined
  // Each stablecoin is used only if the address really is that token (symbol read on-chain).
  const pegNames = Object.keys(p.pegs).filter((k) => !T[k])
  const meta = await pub.multicall({
    allowFailure: true,
    contracts: pegNames.flatMap((k) => [
      { address: p.pegs[k].address, abi: erc20Abi, functionName: 'symbol' } as const,
      { address: p.pegs[k].address, abi: erc20Abi, functionName: 'decimals' } as const,
    ]),
  }).catch(() => [])
  const added: string[] = [], skipped: string[] = []
  pegNames.forEach((k, i) => {
    const sym = meta[2 * i], dec = meta[2 * i + 1]
    const ok = sym?.status === 'success' && dec?.status === 'success' && p.pegs[k].expect.includes(String(sym.result).toUpperCase().replace(/[^A-Z0-9]/g, ''))
    if (!ok) { skipped.push(k); return }
    T[k] = { address: p.pegs[k].address, decimals: Number(dec!.result), ccy: p.pegs[k].ccy }
    added.push(k)
  })
  if (skipped.length) say(`not found on ${p.key} (skipped): ${skipped.join(' ')}`)
  // Robinhood: the official stock tokens, from Robinhood's own list (cached, in case the API is down at startup).
  const multipliers = new Map<string, number>()
  if (p.stocks) {
    const cacheFile = `${dir}/assets.json`
    let assets: any[] = await fetch(`${p.stocks.api}/assets`, { signal: AbortSignal.timeout(30_000) }).then((r) => r.json()).then((j: any) => j.assets ?? []).catch(() => [])
    if (assets.length) writeFileSync(cacheFile, JSON.stringify(assets))
    else if (existsSync(cacheFile)) { assets = JSON.parse(readFileSync(cacheFile, 'utf8')); say('Robinhood asset list unreachable; using the saved copy') }
    for (const a of assets) {
      const d = (a.deployments ?? []).find((x: any) => x.chainId === p.chain.id)
      if (!d || a.status !== 'ASSET_STATUS_ACTIVE' || T[a.tokenSymbol]) continue
      T[a.tokenSymbol] = { address: d.contractAddress, decimals: Number(a.tokenDecimals ?? 18), ccy: `STOCK:${a.tokenSymbol}` }
      multipliers.set(a.tokenSymbol, Number(a.currentMultiplier ?? '1') || 1)
    }
    // Keep the deepest: rank by the WETH sitting in each stock's Uniswap v3 pools (two batched reads).
    // ROBINHOOD_STOCKS=NVDA,TSLA always included; ROBINHOOD_MAX_STOCKS=0 keeps all.
    const forced = new Set((process.env.ROBINHOOD_STOCKS ?? '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean))
    const all = [...multipliers.keys()]
    if (p.stocks.max > 0 && all.length > p.stocks.max && T.WETH && p.dexes[0]) {
      const d0 = p.dexes[0], fees = d0.fees
      const pools = await pub.multicall({ allowFailure: true, contracts: all.flatMap((X) => fees.map((f) => ({ address: d0.factory, abi: factoryAbi, functionName: 'getPool', args: [T[X].address, T.WETH.address, f] } as const))) }).catch(() => [])
      const addrsOf = all.map((_, i) => fees.map((_, j) => pools[i * fees.length + j]).filter((r: any) => r?.status === 'success' && r.result !== zeroAddress).map((r: any) => r.result as Address))
      const bals = await pub.multicall({ allowFailure: true, contracts: addrsOf.flat().map((a) => ({ address: T.WETH.address, abi: erc20Abi, functionName: 'balanceOf', args: [a] } as const)) }).catch(() => [])
      let k = 0
      const depth = new Map(all.map((X, i) => [X, addrsOf[i].reduce((s) => { const r: any = bals[k++]; return s + (r?.status === 'success' ? Number(r.result) / 1e18 : 0) }, 0)]))
      const keep = new Set([...all].sort((a, b) => depth.get(b)! - depth.get(a)!).slice(0, p.stocks.max))
      for (const X of forced) if (multipliers.has(X)) keep.add(X)
      for (const X of all) if (!keep.has(X)) { delete T[X]; multipliers.delete(X) }
      say(`${all.length} official stock tokens from Robinhood's asset list; watching the ${keep.size} deepest: ${[...keep].join(' ')}`)
    } else say(`${multipliers.size} official stock tokens from Robinhood's asset list`)
  }

  const venues: DexVenue[] = []
  const lanesOf = new Map<DexVenue, { lane: Lane; venue: DexVenue }[]>()
  for (const d of [...p.dexes, ...envDexes(p.key)]) {
    const codes = await Promise.all([d.factory, d.quoter, d.router].map((a) => pub.getCode({ address: a }).catch(() => undefined)))
    if (codes.every((c) => c && c !== '0x')) {
      const v = venueFor(d)
      venues.push(v)
      const lanes: Lane[] = [...d.fees.map((fee) => ({ kind: 'fee', fee }) as Lane), ...p.hubs.filter((h) => T[h]).flatMap((hub) => d.fees.map((fee) => ({ kind: 'hubfee', hub, fee }) as Lane))]
      lanesOf.set(v, lanes.map((lane) => ({ lane, venue: venueFor(d, v.pools, lane, v.hubTier) })))
    } else say(`skipping ${d.name}: contracts not found on ${p.key} (check src/hunter/chains.ts)`)
  }
  const dexFactories = [...p.dexes, ...envDexes(p.key)].map((d) => d.factory)
  if (p.mento) {
    const code = await pub.getCode({ address: p.mento.broker }).catch(() => undefined)
    const hubVenue = venues.find((v) => v.name === 'uniswap')
    if (code && code !== '0x' && hubVenue) {
      const m = mentoVenue({ pub, rpc, broker: p.mento.broker, T, toRaw, fromRaw, send, ensureAllowance })
      const receivedByHash = async (t: string, before: bigint, hash: Hex) => received(t, before, (await pub.getTransactionReceipt({ hash })).blockNumber)
      venues.push(hopVenue(m, p.mento.hub, hubVenue, { balanceOf: (t) => balanceOf(t), received: receivedByHash, slippageBps: SLIPPAGE_BPS }))
    } else say('skipping mento: Broker or Uniswap not found')
  }
  // Aerodrome / Velodrome classic pools, and Curve (plus Curve pools that pair a coin with a hub, reached in one hop).
  for (const sv of p.solidly ?? []) {
    const codes = await Promise.all([sv.router, sv.factory].map((a) => pub.getCode({ address: a }).catch(() => undefined)))
    if (codes.every((c) => c && c !== '0x')) venues.push(solidlyVenue({ ...sv, hubs: p.hubs, pub, T, me: account.address, rpc, toRaw, fromRaw, send, ensureAllowance }))
    else say(`skipping ${sv.name}: contracts not found`)
  }
  if (p.curve) {
    const cv = curveVenue({ apiChain: p.curve, pub, T, rpc, toRaw, fromRaw, send, ensureAllowance })
    venues.push(cv)
    const others = () => venues.filter((v) => v !== cv && !v.name.startsWith('curve'))
    const receivedByHash = async (t: string, before: bigint, hash: Hex) => received(t, before, (await pub.getTransactionReceipt({ hash })).blockNumber)
    for (const h of p.hubs.filter((h) => T[h]?.ccy))
      venues.push(hopVenue(cv, h, bestOf(`best-${h}`, others), { name: `curve/via-${h}`, balanceOf: (t) => balanceOf(t), received: receivedByHash, slippageBps: SLIPPAGE_BPS }))
  }
  if (p.v4) {
    const v4 = p.v4
    const codes = await Promise.all([v4.poolManager, v4.quoter, v4.permit2, ...v4.routers].map((a) => pub.getCode({ address: a }).catch(() => undefined)))
    const has = (i: number) => !!codes[i] && codes[i] !== '0x'
    const router = v4.routers.find((_, i) => has(3 + i))
    if (has(0) && has(1) && has(2) && router)
      for (const tier of V4_TIERS) venues.push(v4Venue({ v4, router, tier, bases: ['USDT', ...p.hubs], pub, T, me: account.address, rpc, toRaw, fromRaw, send, ensureAllowance }))
    else say('skipping uniswap-v4: contracts not found')
  }
  if (p.textile) venues.push(textileVenue({ ...p.textile, rpc, chainId: p.chain.id, account, T, toRaw, fromRaw, send, ensureAllowance, balanceOf: (t) => balanceOf(t) }))
  if (!venues.length) { status.error = `no exchanges found on ${p.key}`; say(status.error); return }
  // Tradable coins: every pegged token except the cash token (other dollar coins included: they depeg too).
  const corridors = () => Object.keys(T).filter((k) => k !== 'USDT' && T[k].ccy)
  const ccyOf = (X: string) => T[X]?.ccy ?? 'USD'

  const watcher = new PoolWatcher(pub as any, n(`${p.key.toUpperCase()}_WATCH_MS`, String(p.watchMs ?? process.env.WATCH_MS ?? 1500)))

  // ---------- discovery ----------
  let routes: Route[] = [], discoveredAt = 0
  async function discover() {
    // Mento first: it adds the currencies it lists (NGNm, ZARm...), and the other exchanges then look for their pools.
    const disc = (v: DexVenue) => v.discover(corridors()).catch((e) => { say(`${v.name} discovery: ${errMsg(e)}`); return 0 })
    const mentoCount = await Promise.all(venues.filter((v) => v.name === 'mento').map(disc))
    const others = await Promise.all(venues.filter((v) => v.name !== 'mento').map(disc))
    const counts = venues.map((v) => (v.name === 'mento' ? mentoCount.shift()! : others.shift()!))
    const supported = new Map<string, Set<string>>()
    await Promise.all(venues.map(async (v) => {
      const set = new Set<string>()
      await Promise.all(corridors().map(async (X) => {
        const got = await v.quote('USDT', X, 1_000_000n)
        if (got && (await v.quote(X, 'USDT', got))) set.add(X)
      }))
      supported.set(v.name, set)
    }))
    watcher.set(venues.flatMap((v) => [...v.addrs]))
    routes = buildRoutes(supported, venues)
    let inside = 0
    for (const v of venues) {
      const lanes = lanesOf.get(v) ?? []
      const laneSupport = new Map<string, Set<string>>()
      for (const { lane, venue } of lanes) {
        const set = new Set<string>()
        for (const X of corridors()) {
          if (lane.kind === 'fee' && v.pools.get(pairKey('USDT', X))?.includes(lane.fee)) set.add(X)
          if (lane.kind === 'hubfee' && lane.hub !== X && v.pools.get(pairKey('USDT', lane.hub))?.length && v.pools.get(pairKey(lane.hub, X))?.includes(lane.fee)) set.add(X)
        }
        laneSupport.set(venue.name, set)
      }
      const r = buildRoutes(laneSupport, lanes.map((l) => l.venue))
      inside += r.length
      routes.push(...r)
    }
    discoveredAt = Date.now()
    const traded = new Set(routes.map((r) => r.X))
    status.routes = routes.length
    status.tokens = [...traded]
    const stockList = [...traded].filter((X) => multipliers.has(X)).map((X) => ({ symbol: X, multiplier: multipliers.get(X)! }))
    if (stockList.length) { ctx.fair.watchStocks(stockList); await ctx.fair.refresh() }
    say(`discovery: ${venues.map((v, i) => `${v.name} ${counts[i]} pools`).join(', ')}; ${routes.length} routes (${inside} pool-to-pool)`)
    say(`  coins with a route: ${[...traded].map((X) => `${X}(${ccyOf(X)})`).join(' ') || 'none'}`)
  }

  // ---------- gas ----------
  let nativeUsd = 0, nativeAt = 0, gasPrice = 0n, gasAt = 0
  async function nativePrice() {
    if (p.native === 'USDT') return 1 // the gas token is the cash token's twin (xDAI)
    if (Date.now() - nativeAt > 10 * 60_000 && T[p.native]) {
      for (const v of venues) {
        const q = await v.quote(p.native, 'USDT', 10n ** BigInt(T[p.native].decimals))
        if (q) { nativeUsd = usd(q); nativeAt = Date.now(); break }
      }
    }
    return nativeUsd
  }
  async function gasUsd(units: number) {
    if (Date.now() - gasAt > 15_000) { gasPrice = await pub.getGasPrice().catch(() => gasPrice); gasAt = Date.now() }
    return Number(formatUnits(gasPrice * BigInt(units), 18)) * (await nativePrice())
  }

  // ---------- leftover inventory (loss guard) ----------
  async function bestExit(X: string, amount: bigint) {
    let b: { venue: Venue; out: bigint } | null = null
    for (const v of venues) { const out = await v.quote(X, 'USDT', amount); if (out && (!b || out > b.out)) b = { venue: v, out } }
    return b
  }
  let holding = false
  async function flatten() {
    holding = false
    for (const X of corridors()) {
      const bal = await balanceOf(X).catch(() => 0n)
      if (bal === 0n) { pending.clear(X); continue }
      const exit = await bestExit(X, bal)
      if (!exit) { if (pending.get(X)) { say(`  ${formatUnits(bal, T[X].decimals)} ${X} in wallet, no exchange will quote it right now`); holding = true } continue }
      if (usd(exit.out) < 0.5) continue // dust
      let lot = pending.get(X)
      if (!lot) { pending.add(X, exit.out); lot = pending.get(X)! } // found in the wallet (a deposit): its cost is today's value
      if (!shouldSell(exit.out, lot.costUsdt, Date.now() - lot.since, MAX_FLATTEN_LOSS_BPS, MAX_HOLD_MS)) {
        say(`  holding ${X}: exit $${usd(exit.out).toFixed(4)} vs cost $${usd(lot.costUsdt).toFixed(4)}`); holding = true; continue
      }
      say(`  flatten: ${X} -> ~$${usd(exit.out).toFixed(4)} via ${exit.venue.name}`)
      if (!ctx.live) continue
      try {
        spentNative = 0n
        const before = await balanceOf('USDT')
        const h = await inflight.run(() => exit.venue.swap(X, 'USDT', bal, (exit.out * (10_000n - SLIPPAGE_BPS)) / 10_000n))
        const { blockNumber } = await pub.getTransactionReceipt({ hash: h })
        const out = fromRaw('USDT', await received('USDT', before, blockNumber))
        const gas = Number(formatUnits(spentNative, 18)) * (await nativePrice())
        const net = usd(out) - usd(lot.costUsdt) - gas
        ctx.ledger.add({ chain: p.key, kind: 'flatten', net, note: X })
        log('trades.jsonl', { event: 'flatten', X, usdOut: usd(out), costUsd: usd(lot.costUsdt), gasUsd: gas, net })
        pending.clear(X)
      } catch (e) { say(`  flatten ${X} failed: ${errMsg(e)}`); holding = true }
    }
  }

  // ---------- execution ----------
  const cooldown = new Map<string, number>()
  async function execute(o: Opp) {
    const { X, buy, sell } = o.route
    spentNative = 0n
    const xBefore = await balanceOf(X)
    let h1: Hex
    try { h1 = await buy.swap('USDT', X, o.size, (o.mid * (10_000n - SLIPPAGE_BPS)) / 10_000n) } catch (e) {
      cooldown.set(routeKey(o.route), Date.now() + COOLDOWN_MS)
      const gas = Number(formatUnits(spentNative, 18)) * (await nativePrice())
      if (gas > 0) ctx.ledger.add({ chain: p.key, kind: 'trade', net: -gas, note: `${routeName(o.route)} leg 1 failed` })
      say(`  leg 1 (${buy.name} buy ${X}) failed: ${errMsg(e)}`); log('trades.jsonl', { event: 'cycle', route: routeName(o.route), leg1: errMsg(e) }); return null
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
      const gas = Number(formatUnits(spentNative, 18)) * (await nativePrice())
      const net = usd(out) - usd(o.size) - gas
      ctx.ledger.add({ chain: p.key, kind: 'trade', net, note: routeName(o.route) })
      log('trades.jsonl', { event: 'cycle', route: routeName(o.route), sizeUsd: usd(o.size), gross: usd(out) - usd(o.size), gasUsd: gas, net, tx1: h1, tx2: h2 })
      return net
    } catch (e) {
      cooldown.set(routeKey(o.route), Date.now() + COOLDOWN_MS)
      const gas = Number(formatUnits(spentNative, 18)) * (await nativePrice())
      ctx.ledger.add({ chain: p.key, kind: 'trade', net: -gas, note: `${routeName(o.route)} leg 2 failed (leftover goes to the loss guard)` })
      say(`  leg 2 (${sell.name} sell ${X}) failed: ${errMsg(e)}`); log('trades.jsonl', { event: 'cycle', route: routeName(o.route), tx1: h1, leg2: errMsg(e) })
      notify(`${p.key}: ${routeName(o.route)} leg 2 failed; holding ${X}, the loss guard will sell it.`)
      return null
    }
  }

  // ---------- fair price and the peg guards ----------
  const probeUsd = BigInt(Math.round(MIN_TRADE_USD * 1e6))
  // A venue's deviation from fair for coin X, from a tiny round trip through it. Recorded on the peg board.
  async function venueDev(v: Venue, X: string, fair: number): Promise<number | null> {
    const t = await v.quote('USDT', X, probeUsd)
    if (!t) return null
    const back = await v.quote(X, 'USDT', t)
    if (!back) return null
    const dev = poolDev(usd(probeUsd), Number(formatUnits(t, T[X].decimals)), usd(back), fair)
    if (dev !== null) ctx.board.observe(p.key, X, ccyOf(X), v.name, dev)
    return dev
  }
  // Feed the peg board from every venue now and then, so a depeg is seen across all of a coin's pools.
  let observedAt = 0
  async function observeAll() {
    observedAt = Date.now()
    const pairs = new Map<string, Set<Venue>>()
    for (const r of routes) for (const v of [r.buy, r.sell]) pairs.set(r.X, new Set([...(pairs.get(r.X) ?? []), v]))
    await Promise.all([...pairs].map(async ([X, vs]) => {
      const f = ctx.fair.get(ccyOf(X))
      if (f.usdPer) await Promise.all([...vs].map((v) => venueDev(v, X, f.usdPer!).catch(() => null)))
    }))
  }
  async function check(o: Opp): Promise<{ why: string | null; buyDev: number | null; sellDev: number | null }> {
    const X = o.route.X, f = ctx.fair.get(ccyOf(X))
    const [buyDev, sellDev] = f.usdPer
      ? await Promise.all([venueDev(o.route.buy, X, f.usdPer), venueDev(o.route.sell, X, f.usdPer)])
      : [null, null]
    const why = blockReason({
      fairOk: f.usdPer !== null, fairNote: f.note,
      frozen: ctx.board.frozen(p.key, X, ccyOf(X)),
      stuckBuy: ctx.board.stuck(p.key, X, o.route.buy.name), stuckSell: ctx.board.stuck(p.key, X, o.route.sell.name),
      buyDev, sellDev, sizeUsd: usd(o.size), netUsd: o.net,
    })
    return { why, buyDev, sellDev }
  }

  // ---------- new pools ----------
  // A brand-new pool for one of our coins is checked within NEWPOOL_SEC: freshly seeded pools are where the
  // biggest mispricings happen.
  let poolBlock = 0n, poolAt = 0
  async function newPools(): Promise<boolean> {
    poolAt = Date.now()
    const head = await pub.getBlockNumber()
    if (poolBlock === 0n) { poolBlock = head; return false }
    if (head <= poolBlock) return false
    const from = head - poolBlock > 2000n ? head - 1999n : poolBlock + 1n
    const ours = corridors().map((k) => T[k].address)
    const slip = [...p.dexes, ...envDexes(p.key)].filter((d) => d.kind === 'slipstream').map((d) => d.factory)
    const [a, b, c, d] = await Promise.all([
      pub.getLogs({ address: dexFactories, event: poolCreated, args: { token0: ours }, fromBlock: from, toBlock: head }).catch(() => []),
      pub.getLogs({ address: dexFactories, event: poolCreated, args: { token1: ours }, fromBlock: from, toBlock: head }).catch(() => []),
      slip.length ? pub.getLogs({ address: slip, event: slipPoolCreated, args: { token0: ours }, fromBlock: from, toBlock: head }).catch(() => []) : [],
      slip.length ? pub.getLogs({ address: slip, event: slipPoolCreated, args: { token1: ours }, fromBlock: from, toBlock: head }).catch(() => []) : [],
    ])
    poolBlock = head
    const found = [...a, ...b, ...c, ...d]
    if (!found.length) return false
    const name = (addr: string) => Object.keys(T).find((k) => T[k].address.toLowerCase() === addr.toLowerCase()) ?? addr.slice(0, 8)
    const list = found.map((l: any) => `${name(l.args.token0)}/${name(l.args.token1)} ${l.args.fee !== undefined ? `${Number(l.args.fee) / 10_000}%` : `ts${l.args.tickSpacing}`}`).join(', ')
    say(`NEW POOL: ${list}; rediscovering now`)
    notify(`${p.key}: new pool ${list}. Checking it for a mispriced start.`)
    return true
  }

  // ---------- watch mode bookkeeping ----------
  const seenOpp = new Map<string, number>() // route -> last 10-minute bucket counted
  function recordWatch(o: Opp, buyDev: number | null, sellDev: number | null) {
    log('opps.jsonl', { route: routeName(o.route), sizeUsd: usd(o.size), net: o.net, gapPct: (o.net / usd(o.size)) * 100, buyDev, sellDev, mode: st().mode })
    if (st().mode !== 'watch') return
    const bucket = Math.floor(Date.now() / 600_000)
    if (seenOpp.get(routeKey(o.route)) === bucket) return
    seenOpp.set(routeKey(o.route), bucket)
    st().watchOpps += 1
    st().watchUsd += o.net
    ctx.store.save()
  }

  // ---------- one scan ----------
  async function cycle(focus: Set<string> | null = null) {
    const s = st()
    const tradeLive = ctx.live && s.mode === 'live' && !ctx.store.state.paused && process.env.HUNTER_PAUSED !== '1'
    if (focus && [...focus].some((t) => p.hubs.includes(t))) focus = null
    if (ctx.live) await flatten()
    if (holding) { status.lastLine = 'holding leftover coins; no new trades until they are sold'; say(`  ${status.lastLine}`); return }
    if (!discoveredAt || Date.now() - discoveredAt > 6 * 3_600_000) await discover() // a chain with no routes waits too
    if (!focus && Date.now() - poolAt > NEWPOOL_MS && (await newPools().catch(() => false))) await discover()
    if (!focus && Date.now() - observedAt > OBSERVE_MS) await observeAll()
    const live = routes.filter((r) => (cooldown.get(routeKey(r)) ?? 0) < Date.now() && (!focus || focus.has(r.X)))
    if (!live.length) { status.lastLine = routes.length ? 'all routes cooling down' : 'no routes on this chain (no exchange pairs our coins with the cash token)'; return }
    status.swapGasUsd = await gasUsd(180_000)
    status.gasOk = status.swapGasUsd <= MAX_SWAP_GAS_USD
    const reserved = ctx.store.state.reserved[p.key] ?? 0
    const c = clientsFor(p), sav = await aaveInfo(c).catch(() => null)
    const liquidRaw = await balanceOf('USDT').catch(() => 0n), parkedRaw = sav ? await parkedUnits(c) : 0n
    const liquidUsd = usd(fromRaw('USDT', liquidRaw)), parkedUsd = usd(fromRaw('USDT', parkedRaw))
    const cashUsd = Math.max(0, liquidUsd + parkedUsd - reserved) // parked cash counts: a trade pulls it out first
    status.cashUsd = cashUsd; status.parkedUsd = parkedUsd; status.apyPct = sav?.apyPct ?? 0
    // Size grows with the chain's cash. Watch mode sizes as if the chain held WATCH_CAPITAL_USD (your real capital),
    // so what it records is what that money would actually have earned. The size search picks the best size.
    const sizeUsd = tradeLive ? maxTradeUsd(cashUsd) : maxTradeUsd(Math.max(cashUsd, WATCH_CAPITAL_USD))
    const maxSize = parseUnits(sizeUsd.toFixed(6), 6), minSize = probeUsd
    if (tradeLive && maxSize < minSize) { status.lastLine = `not enough ${p.cashName} to trade (have $${cashUsd.toFixed(2)})`; if (!focus) say(`  ${status.lastLine}`); return }
    const gas = new Map<string, number>()
    for (const r of live) gas.set(routeKey(r), await gasUsd(r.buy.gas + r.sell.gas))
    // Many routes (Robinhood has 1,000+): estimate them all from one buy and one sell quote per pool and coin first.
    const candidates = live.length > PREFILTER_FROM ? await prefilterRoutes(live, minSize) : live
    const opps = await scanRoutes(candidates, minSize, maxSize, (r) => gas.get(routeKey(r)) ?? 0, MAX_EXIT_IMPACT_BPS)
    status.lastScanAt = Date.now()
    // Check the best candidates against the peg guards; the first that passes is the trade.
    let chosen: { o: Opp; buyDev: number | null; sellDev: number | null } | null = null
    const blocked: string[] = []
    for (const o of opps.filter((x) => x.net > 0).slice(0, 8)) {
      const c = await check(o)
      if (!c.why) { chosen = { o, ...c }; break }
      blocked.push(`${routeName(o.route)}: ${c.why}`)
    }
    if (!focus) for (const o of opps.slice(0, 3)) say(`  ${routeName(o.route).padEnd(26)} $${usd(o.size).toFixed(2).padStart(6)} -> $${usd(o.out).toFixed(4)}  net ${o.net >= 0 ? '+' : ''}${o.net.toFixed(4)}`)
    if (!focus) for (const b of blocked.slice(0, 2)) say(`  skip ${b}`)
    if (opps[0]) appendFileSync(`${dir}/scans.jsonl`, JSON.stringify({ ts: new Date().toISOString(), route: routeName(opps[0].route), sizeUsd: usd(opps[0].size), net: opps[0].net, would: !!chosen, mode: s.mode }) + '\n')
    if (!chosen) {
      status.lastLine = `no trade (${live.length} routes, ${candidates.length} looked close)  ${p.cashName} $${cashUsd.toFixed(2)}  today ${ctx.ledger.today(p.key) >= 0 ? '+' : ''}${ctx.ledger.today(p.key).toFixed(4)}  [${s.mode}]`
      if (!focus) say(`  ${status.lastLine}`)
      return
    }
    const { o, buyDev, sellDev } = chosen
    const line = `${routeName(o.route)} $${usd(o.size).toFixed(2)}, expected +$${o.net.toFixed(4)} (${((o.net / usd(o.size)) * 100).toFixed(2)}%; buy pool ${pct(buyDev)}, sell pool ${pct(sellDev)} vs fair)`
    status.lastLine = `${tradeLive ? 'TRADING' : 'would trade'}: ${line}`
    say(`  >> ${status.lastLine}`)
    if (!tradeLive) { recordWatch(o, buyDev, sellDev); return }
    if (!status.gasOk) { say(`  not trading: a swap costs $${status.swapGasUsd.toFixed(4)} right now (MAX_SWAP_GAS_USD $${MAX_SWAP_GAS_USD})`); return }
    if (!tradingAllowed(ctx.ledger.today(p.key), MAX_DAILY_LOSS_USD)) { say(`  paused for today: ${p.key} lost $${MAX_DAILY_LOSS_USD}`); return }
    if (!tradingAllowed(ctx.ledger.today(null), GLOBAL_DAILY_LOSS_USD)) { say(`  paused for today: all chains together lost $${GLOBAL_DAILY_LOSS_USD}`); return }
    log('opps.jsonl', { route: routeName(o.route), sizeUsd: usd(o.size), net: o.net, buyDev, sellDev, mode: 'live' })
    // Cash parked in Aave comes out first, in this same lock, so the trade has it. Its gas counts in the trade.
    const short = o.size - fromRaw('USDT', liquidRaw - toRaw('USDT', BigInt(Math.round(reserved * 1e6))))
    if (short > 0n) {
      if (!sav || parkedRaw === 0n) { say('  not enough liquid cash for this trade'); return }
      const want = toRaw('USDT', short + short / 100n + 1000n)
      const take = want > parkedRaw ? parkedRaw : want
      try {
        spentNative = 0n
        await inflight.run(() => aaveWithdraw(c, take, send))
        const gas = Number(formatUnits(spentNative, 18)) * (await nativePrice())
        if (gas > 0) ctx.ledger.add({ chain: p.key, kind: 'fee', net: -gas, note: 'took cash out of Aave for a trade' })
        const S = ctx.store.state
        S.parked[p.key] = Math.max(0, (S.parked[p.key] ?? 0) - usd(fromRaw('USDT', take)))
        ctx.store.save()
      } catch (e) { say(`  could not take cash out of Aave (${errMsg(e)}); skipping this trade`); return }
    }
    const net = await inflight.run(() => execute(o)) // the whole scan already holds this chain's lock
    say(`  result: ${net === null ? 'incomplete (leftover managed by the loss guard)' : `${net >= 0 ? '+' : ''}${net.toFixed(4)} after gas`}`)
    if (net !== null && usd(o.size) >= ALERT_TRADE_USD) notify(`${p.key}: ${routeName(o.route)} $${usd(o.size).toFixed(2)} -> ${net >= 0 ? '+' : ''}$${net.toFixed(4)} after gas`)
  }

  status.started = true
  say(`${ctx.live ? 'LIVE switch on' : 'WATCH ONLY (HUNTER_LIVE=0)'} | mode ${st().mode} | wallet ${account.address} | cash ${p.cashName} | ${venues.map((v) => v.name).join(' + ')}${added.length ? ` | coins: ${added.join(' ')}` : ''}`)
  // MODE both (default): full scan every INTERVAL, and rescan as soon as a watched pool trades.
  const intervalMs = n(`${p.key.toUpperCase()}_INTERVAL_SEC`, String(p.intervalSec ?? INTERVAL_MS / 1000)) * 1000
  const fullEvery = MODE === 'watch' ? n('WATCH_FULL_MIN', '10') * 60_000 : intervalMs
  let focus: Set<string> | null = null, lastFull = 0
  while (!ctx.stopping()) {
    if (!focus) lastFull = Date.now()
    try { await ctx.locks.run(p.key, () => cycle(focus)); status.error = undefined } catch (e) { status.error = errMsg(e); say(`cycle error: ${status.error}`) }
    if (ctx.stopping()) break
    const left = Math.max(0, lastFull + fullEvery - Date.now())
    if (MODE === 'scan') { focus = null; await sleep(left); continue }
    focus = await watcher.wait(left, ctx.stopping)
  }
}

// Read-only helpers for the treasury and /status: cash and gas on a chain.
export async function balances(p: ChainProfile) {
  const { pub, account } = clientsFor(p)
  const [cash, gas, dec] = await Promise.all([
    pub.readContract({ address: p.tokens.USDT.address, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }),
    pub.getBalance({ address: account.address }),
    pub.readContract({ address: p.tokens.USDT.address, abi: erc20Abi, functionName: 'decimals' }),
  ])
  return { cash, cashUsd: Number(formatUnits(cash, Number(dec))), cashDecimals: Number(dec), gas, gasOk: gas >= parseUnits(p.minGas, 18) }
}

export const readJsonl = (file: string): any[] => {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
}
