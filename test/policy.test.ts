import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allocate, freshState, nextState, planSweep, type LifecycleRules } from '../src/hunter/policy.js'

const DAY = 86_400_000, T0 = Date.parse('2026-11-01T00:00:00Z')
const L: LifecycleRules = { watchDays: 3, promoteOpps: 5, promoteUsd: 0.1, reviewDays: 7, pausedDays: 7 }

test('watch chain: promoted after 3 days only with enough gaps and cheap gas', () => {
  const s = { ...freshState('watch', T0), watchOpps: 6, watchUsd: 0.4 }
  assert.equal(nextState(s, T0 + 2 * DAY, 0, true, L), null) // too early
  assert.equal(nextState(s, T0 + 3.1 * DAY, 0, false, L), null) // gas too dear
  assert.equal(nextState({ ...s, watchOpps: 3 }, T0 + 4 * DAY, 0, true, L), null) // too few gaps
  assert.equal(nextState({ ...s, watchUsd: 0.05 }, T0 + 4 * DAY, 0, true, L), null) // gaps too small
  const n = nextState(s, T0 + 3.1 * DAY, 0, true, L)!
  assert.equal(n.mode, 'live')
  assert.match(n.note!, /promoted: 6 gaps worth \$0.40/)
})

test('live chain: paused after 7 days with no profit after gas; kept while it earns', () => {
  const s = freshState('live', T0)
  assert.equal(nextState(s, T0 + 6 * DAY, -1, true, L), null) // review only after 7 days
  assert.equal(nextState(s, T0 + 8 * DAY, 0.5, true, L), null)
  assert.equal(nextState(s, T0 + 8 * DAY, 0, true, L)!.mode, 'paused')
  assert.equal(nextState(s, T0 + 8 * DAY, -0.2, true, L)!.mode, 'paused')
})

test('paused chain goes back to watching after 7 days; manual chains are left alone', () => {
  const p = freshState('paused', T0)
  assert.equal(nextState(p, T0 + 6 * DAY, 0, true, L), null)
  const w = nextState(p, T0 + 7 * DAY, 0, true, L)!
  assert.equal(w.mode, 'watch')
  assert.equal(w.watchOpps, 0) // a fresh start
  assert.equal(nextState({ ...freshState('live', T0), manual: true }, T0 + 30 * DAY, -5, true, L), null)
})

const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0)
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9

test('allocate: only live chains, by earnings per dollar, within 5%..40%', () => {
  const r = allocate([
    { key: 'a', live: true, roi: 0.10 }, { key: 'b', live: true, roi: 0.05 }, { key: 'c', live: true, roi: 0.01 },
    { key: 'd', live: true, roi: 0 }, { key: 'w', live: false, roi: 1 },
  ], 100, { minPct: 5, maxPct: 40 })
  assert.ok(near(sum(r), 100))
  assert.equal(r.w, undefined)
  assert.ok(near(r.a, 40)) // capped
  assert.ok(near(r.d, 5)) // floor
  assert.ok(r.b > r.c && r.c >= 5)
})

test('allocate: no history -> equal; one live chain -> everything; none -> nothing', () => {
  const eq = allocate([{ key: 'a', live: true, roi: null }, { key: 'b', live: true, roi: null }, { key: 'c', live: true, roi: null }], 90, { minPct: 5, maxPct: 40 })
  assert.ok(near(eq.a, 30) && near(eq.b, 30) && near(eq.c, 30))
  assert.ok(near(allocate([{ key: 'a', live: true, roi: 0.2 }], 50, { minPct: 5, maxPct: 40 }).a, 50))
  assert.deepEqual(allocate([{ key: 'a', live: false, roi: 0.2 }], 50), {})
})

test('allocate: a new chain is scored like the median chain', () => {
  const r = allocate([{ key: 'a', live: true, roi: 0.02 }, { key: 'b', live: true, roi: 0.02 }, { key: 'new', live: true, roi: null }], 30, { minPct: 5, maxPct: 40 })
  assert.ok(near(r.new, r.a))
})

const SW = { atUsd: 20, pct: 50, minChainUsd: 3 }
test('sweep: not before $20 of new profit', () => {
  const p = planSweep([{ key: 'a', cum: 12, mark: 0 }, { key: 'b', cum: 7, mark: 0 }], SW)
  assert.equal(p.due, false)
  assert.ok(near(p.newProfit, 19))
})

test('sweep: 50% of the new profit per chain; small parts wait without losing their share', () => {
  const p = planSweep([{ key: 'a', cum: 30, mark: 10 }, { key: 'b', cum: 4, mark: 0 }, { key: 'c', cum: 1, mark: 3 }], SW)
  assert.equal(p.due, true)
  assert.ok(near(p.newProfit, 24)) // a +20, b +4, c below its mark
  assert.deepEqual(p.items, [{ key: 'a', usd: 10, newMark: 30 }])
  assert.deepEqual(p.waiting, ['b']) // $2 < $3: waits, its mark stays at 0
})

test('sweep: /withdraw forces it below the threshold', () => {
  const p = planSweep([{ key: 'a', cum: 8, mark: 0 }], SW, true)
  assert.deepEqual(p.items, [{ key: 'a', usd: 4, newMark: 8 }])
  assert.equal(planSweep([{ key: 'a', cum: 0, mark: 0 }], SW, true).due, false)
})
