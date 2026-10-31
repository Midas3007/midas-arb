import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bestSize, buildRoutes, scanRoutes, shouldSell, tradingAllowed, type Venue } from '../src/engine.js'
import { PendingStore } from '../src/pending.js'
import type { TokenKey } from '../src/config.js'

const $ = (d: number) => BigInt(Math.round(d * 1e6)) // USDT units
const fail = async (): Promise<never> => { throw new Error('not used') }

// Constant-product AMM: price `px` X per USDT, depth `usdDepth` dollars a side. Bigger trades get worse prices.
function amm(name: string, px: number, usdDepth: number, feeBps = 5): Venue {
  return {
    name, gas: 200_000, swap: fail,
    async quote(tin, _tout, amountIn) {
      const x = Number(amountIn) / 1e6
      const net = x * (1 - feeBps / 10_000)
      if (tin === 'USDT') return $(net * px * usdDepth / (usdDepth + net))        // USDT -> X (X also scaled 1e6 here)
      return $(net / px * usdDepth * px / (usdDepth * px + net))                  // X -> USDT
    },
  }
}
// RFQ venue: flat price, no size impact, fails above a limit.
function rfq(name: string, px: number, maxUsd = 1_000): Venue {
  return {
    name, gas: 250_000, swap: fail,
    async quote(tin, _tout, amountIn) {
      const x = Number(amountIn) / 1e6
      if (tin === 'USDT') return x > maxUsd ? null : $(x * px)
      return x / px > maxUsd ? null : $(x / px)
    },
  }
}

test('buildRoutes pairs every two different venues that both trade the token', () => {
  const a = amm('uniswap', 5, 1000), b = rfq('textile', 5), c = rfq('mento', 5)
  const supported = new Map<string, Set<TokenKey>>([
    ['uniswap', new Set<TokenKey>(['wBRL', 'BRLm'])], ['textile', new Set<TokenKey>(['wBRL'])], ['mento', new Set<TokenKey>(['BRLm'])],
  ])
  const names = buildRoutes(supported, [a, b, c]).map((r) => `${r.X}:${r.buy.name}>${r.sell.name}`).sort()
  assert.deepEqual(names, ['BRLm:mento>uniswap', 'BRLm:uniswap>mento', 'wBRL:textile>uniswap', 'wBRL:uniswap>textile'])
})

test('bestSize finds the profitable interior size against an AMM with price impact', async () => {
  // Uniswap sells X cheap (5.10 X per $) with $300 depth; Textile buys X back at 5.00 per $: a 2% gap.
  const route = { X: 'wBRL' as TokenKey, buy: amm('uniswap', 5.1, 300), sell: rfq('textile', 5.0) }
  const opp = await bestSize(route, $(2), $(140), 0.001)
  assert.ok(opp)
  assert.ok(opp!.net > 0, `expected a profit, got ${opp!.net}`)
  // At $140 the price impact eats the gap; the best size must be smaller than the max.
  const atMax = await bestSize(route, $(140), $(140), 0.001)
  assert.ok(opp!.size < $(140))
  assert.ok(opp!.net > atMax!.net)
})

test('bestSize reports no profit when venues agree, and gas can flip a thin edge negative', async () => {
  const flat = { X: 'wBRL' as TokenKey, buy: rfq('textile', 5), sell: rfq('mento', 5) }
  const o = await bestSize(flat, $(2), $(70), 0)
  assert.ok(o && Math.abs(o.edge) < 1e-6)
  const thin = { X: 'wBRL' as TokenKey, buy: rfq('a', 5.0005), sell: rfq('b', 5) } // 0.01% gap
  const t = await bestSize(thin, $(2), $(70), 0.05)
  assert.ok(t && t.edge > 0 && t.net < 0)
})

test('scanRoutes ranks routes by profit after gas and survives venues that throw', async () => {
  const broken: Venue = { name: 'broken', gas: 1, swap: fail, quote: async () => { throw new Error('rpc down') } }
  const good = { X: 'wBRL' as TokenKey, buy: rfq('a', 5.05), sell: rfq('b', 5) }
  const better = { X: 'BRLm' as TokenKey, buy: rfq('c', 5.1), sell: rfq('d', 5) }
  const bad = { X: 'KESm' as TokenKey, buy: broken, sell: rfq('e', 5) }
  const opps = await scanRoutes([good, bad, better], $(2), $(50), () => 0.001)
  assert.equal(opps.length, 2)
  assert.equal(opps[0].route.X, 'BRLm')
})

test('sizeLadder spans min to max on a log scale', async () => {
  const { sizeLadder } = await import('../src/engine.js')
  const l = sizeLadder($(2), $(140))
  assert.equal(l[0], $(140)); assert.equal(l[l.length - 1], $(2)); assert.equal(l.length, 6)
})

test('loss guard: hold small losses, sell break-even or better, sell anything after max hold', () => {
  const cost = $(70)
  assert.equal(shouldSell($(69.8), cost, 60_000, 50, 1_800_000), true)   // -0.29%: within 0.5%
  assert.equal(shouldSell($(69.0), cost, 60_000, 50, 1_800_000), false)  // -1.4%: hold
  assert.equal(shouldSell($(69.0), cost, 1_800_000, 50, 1_800_000), true) // held 30 min: sell anyway
  assert.equal(shouldSell($(71), cost, 0, 50, 1_800_000), true)
})

test('daily kill switch', () => {
  assert.equal(tradingAllowed(-4.99, 5), true)
  assert.equal(tradingAllowed(-5, 5), false)
  assert.equal(tradingAllowed(-100, 0), true) // 0 = off
})

test('pending inventory survives a restart and merges lots', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kiyoshi-')), 'pending.json')
  const a = new PendingStore(file)
  a.add('cNGN', $(70), 1000)
  a.add('cNGN', $(5), 2000)
  const b = new PendingStore(file) // "restart"
  assert.deepEqual(b.get('cNGN'), { costUsdt: $(75), since: 1000 })
  b.clear('cNGN')
  assert.equal(new PendingStore(file).get('cNGN'), undefined)
})

test('scanRoutes quotes a losing route once instead of running the size search', async () => {
  let calls = 0
  const counted = (v: Venue): Venue => ({ ...v, quote: (a, b, c) => { calls++; return v.quote(a, b, c) } })
  const losing = { X: 'wBRL' as TokenKey, buy: counted(rfq('a', 4.9)), sell: rfq('b', 5) }
  const [o] = await scanRoutes([losing], $(2), $(70), () => 0)
  assert.ok(o.edge < 0)
  assert.equal(calls, 1)
})

test('exit impact: sizes that push the exit pool more than the limit are not chosen', async () => {
  const { exitImpactBps, scanRoutes } = await import('../src/engine.js')
  // Buy pool is deep and 3% cheap; the exit pool is shallow ($500 a side), so bigger sizes move its price a lot.
  const routes = [{ X: 'X', buy: amm('cheap', 1.03, 1_000_000), sell: amm('thin', 1, 500) }]
  const free = await scanRoutes(routes, $(1), $(40), () => 0)
  const capped = await scanRoutes(routes, $(1), $(40), () => 0, 100)
  const probe = (await scanRoutes(routes, $(1), $(1), () => 0))[0]
  assert.ok(exitImpactBps(capped[0], probe) <= 100)
  assert.ok(exitImpactBps(free[0], probe) > 100)
  assert.ok(capped[0].size < free[0].size)
})

test('prefilter keeps the profitable route and drops clearly losing ones', async () => {
  const { prefilterRoutes, buildRoutes } = await import('../src/engine.js')
  const cheap = amm('cheap', 1.02, 100_000), fair1 = amm('fair1', 1.0, 100_000), fair2 = amm('fair2', 1.0, 100_000)
  const routes = buildRoutes(new Map([['cheap', new Set(['X'])], ['fair1', new Set(['X'])], ['fair2', new Set(['X'])]]), [cheap, fair1, fair2])
  const kept = await prefilterRoutes(routes, $(1))
  const names = kept.map((r) => `${r.buy.name}>${r.sell.name}`)
  assert.ok(names.includes('cheap>fair1') && names.includes('cheap>fair2'))
  assert.ok(!names.includes('fair1>cheap') && !names.includes('fair2>cheap'))
})
