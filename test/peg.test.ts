import { test } from 'node:test'
import assert from 'node:assert/strict'
import { combine, fxClosed, maxAgeMs } from '../src/hunter/fair.js'
import { blockReason, maxTradeUsd, PegBoard, poolDev, type PegRules } from '../src/hunter/peg.js'

const H = 3_600_000
// Wednesday 2026-10-28 12:00 UTC (markets open) and Saturday 2026-10-31 12:00 UTC (closed)
const WED = Date.parse('2026-10-28T12:00:00Z'), SAT = Date.parse('2026-10-31T12:00:00Z')

test('FX weekend: Friday evening to Sunday evening counts as closed', () => {
  assert.equal(fxClosed(WED), false)
  assert.equal(fxClosed(SAT), true)
  assert.equal(fxClosed(Date.parse('2026-10-30T21:00:00Z')), true) // Friday night
  assert.equal(fxClosed(Date.parse('2026-11-01T23:30:00Z')), false) // Sunday late: open again
  assert.ok(maxAgeMs('live', SAT) > maxAgeMs('live', WED))
})

const opts = { agreePct: 2, allowSingle: false }
test('fair price: median of fresh sources that agree', () => {
  const f = combine('NGN', [
    { source: 'mento', usdPer: 1 / 1346, at: WED - 60_000 },
    { source: 'erapi', usdPer: 1 / 1345, at: WED - 10 * H },
    { source: 'fawaz', usdPer: 1 / 1347, at: WED - 12 * H },
  ], WED, opts)
  assert.equal(f.status, 'ok')
  assert.ok(Math.abs(1 / f.usdPer! - 1346) < 0.01)
})

test('fair price: sources that disagree block trading', () => {
  const f = combine('NGN', [
    { source: 'mento', usdPer: 1 / 1346, at: WED - 60_000 },
    { source: 'erapi', usdPer: 1 / 1500, at: WED - H },
  ], WED, opts)
  assert.equal(f.status, 'disagree')
  assert.equal(f.usdPer, null)
})

test('fair price: a stale oracle is dropped, leaving one source -> not tradable by default', () => {
  const qs = [{ source: 'mento', usdPer: 1 / 1346, at: WED - 5 * H }, { source: 'erapi', usdPer: 1 / 1345, at: WED - H }]
  const f = combine('NGN', qs, WED, opts)
  assert.equal(f.status, 'single')
  assert.equal(f.usdPer, null)
  assert.ok(f.note.includes('stale: mento'))
  assert.notEqual(combine('NGN', qs, WED, { agreePct: 2, allowSingle: true }).usdPer, null)
})

test('fair price: the same 5-hour-old oracle is fine over the weekend', () => {
  const f = combine('NGN', [{ source: 'mento', usdPer: 1 / 1346, at: SAT - 5 * H }, { source: 'erapi', usdPer: 1 / 1345, at: SAT - H }], SAT, opts)
  assert.equal(f.status, 'ok')
})

test('fair price: USD is always 1', () => {
  assert.deepEqual(combine('USD', [], WED, opts).usdPer, 1)
})

test('poolDev: geometric mid of buy and sell prices vs fair', () => {
  // Pool sells 1000 units for $1 and buys them back for $0.99 (1% round-trip fee); fair is $0.001 per unit.
  const d = poolDev(1, 1000, 0.99, 0.001)!
  assert.ok(Math.abs(d - (Math.sqrt(0.99) - 1)) < 1e-12)
  assert.equal(poolDev(0, 1, 1, 1), null)
})

const R: PegRules = { depegPct: 3, suspiciousPct: 20, stuckHours: 24, minGapPct: 0.3, minNetUsd: 0.01 }

test('depeg: all pools of a coin below the peg freezes it on that chain; one cheap pool does not', () => {
  const b = new PegBoard(R)
  const t = WED
  b.observe('base', 'cNGN', 'NGN', 'uniswap', -0.06, t)
  b.observe('base', 'cNGN', 'NGN', 'pancake', -0.002, t)
  assert.equal(b.frozen('base', 'cNGN', 'NGN', t), null) // one dislocated pool: that is the opportunity
  b.observe('base', 'cNGN', 'NGN', 'pancake', -0.05, t)
  assert.match(b.frozen('base', 'cNGN', 'NGN', t)!, /below the peg/)
  b.observe('base', 'cNGN', 'NGN', 'pancake', -0.001, t + 1000)
  assert.equal(b.frozen('base', 'cNGN', 'NGN', t + 1000), null) // unfreezes when pools come back
})

test('depeg on two chains freezes the currency everywhere', () => {
  const b = new PegBoard(R), t = WED
  for (const c of ['base', 'bsc']) { b.observe(c, 'cNGN', 'NGN', 'a', -0.08, t); b.observe(c, 'cNGN', 'NGN', 'b', -0.07, t) }
  b.observe('polygon', 'cNGN', 'NGN', 'a', -0.07, t) // polygon has a single cheap pool: alone it would be a trade
  b.observe('polygon', 'cNGN', 'NGN', 'b', 0, t)
  assert.match(b.frozen('polygon', 'cNGN', 'NGN', t)!, /NGN below its peg on base, bsc/)
})

test('old observations do not freeze anything', () => {
  const b = new PegBoard(R)
  b.observe('base', 'EURC', 'EUR', 'a', -0.1, WED); b.observe('base', 'EURC', 'EUR', 'b', -0.1, WED)
  assert.equal(b.frozen('base', 'EURC', 'EUR', WED + H), null)
})

test('stuck pool: off its peg for more than 24h', () => {
  const b = new PegBoard(R)
  b.observe('bsc', 'TRYB', 'TRY', 'pancake', -0.05, WED)
  b.observe('bsc', 'TRYB', 'TRY', 'pancake', -0.04, WED + 23 * H)
  assert.equal(b.stuck('bsc', 'TRYB', 'pancake', WED + 23 * H), false)
  b.observe('bsc', 'TRYB', 'TRY', 'pancake', -0.04, WED + 25 * H)
  assert.equal(b.stuck('bsc', 'TRYB', 'pancake', WED + 25 * H), true)
  b.observe('bsc', 'TRYB', 'TRY', 'pancake', -0.005, WED + 26 * H) // back within 1%: the clock resets
  assert.equal(b.stuck('bsc', 'TRYB', 'pancake', WED + 26 * H), false)
})

const ok = { fairOk: true, fairNote: '', frozen: null, stuckBuy: false, stuckSell: false, buyDev: -0.02, sellDev: 0.001, sizeUsd: 10, netUsd: 0.15 }
test('blockReason: a clean 1.5% gap passes', () => assert.equal(blockReason(ok, R), null))
test('blockReason: each guard blocks', () => {
  assert.match(blockReason({ ...ok, fairOk: false, fairNote: 'sources disagree' }, R)!, /no fair price/)
  assert.match(blockReason({ ...ok, frozen: 'x' }, R)!, /frozen/)
  assert.match(blockReason({ ...ok, buyDev: -0.35 }, R)!, /suspicious/)
  assert.match(blockReason({ ...ok, stuckSell: true }, R)!, /24h/)
  assert.match(blockReason({ ...ok, netUsd: 0.005 }, R)!, /under \$0.01/)
  assert.match(blockReason({ ...ok, sizeUsd: 100, netUsd: 0.2 }, R)!, /gap 0.20% under 0.3%/)
})

test('maxTradeUsd: 20% of cash, a $2 floor for small wallets, capped', () => {
  const o = { pct: 20, cap: 100, floor: 2 }
  assert.equal(maxTradeUsd(100, o), 20)
  assert.equal(maxTradeUsd(5, o), 2) // 20% would be $1: small wallets may still trade $2
  assert.equal(maxTradeUsd(1, o), 0.9) // never more than 90% of the cash
  assert.equal(maxTradeUsd(10_000, o), 100)
  assert.equal(maxTradeUsd(0, o), 0)
})

test('depeg limit per currency: wARS 7% off the official rate everywhere is not a depeg', () => {
  const b = new PegBoard({ ...R, depegByCcy: { ARS: 12 } })
  b.observe('base', 'wARS', 'ARS', 'a', -0.07, WED); b.observe('base', 'wARS', 'ARS', 'b', -0.068, WED)
  assert.equal(b.frozen('base', 'wARS', 'ARS', WED), null)
  b.observe('base', 'wARS', 'ARS', 'a', -0.2, WED); b.observe('base', 'wARS', 'ARS', 'b', -0.19, WED)
  assert.match(b.frozen('base', 'wARS', 'ARS', WED)!, /below the peg/)
})
