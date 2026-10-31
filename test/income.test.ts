import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parkPlan } from '../src/hunter/savings.js'
import { worthClaiming } from '../src/hunter/rewards.js'

test('parkPlan: cash above the trading buffer is parked; small amounts stay', () => {
  assert.deepEqual(parkPlan(100, 0, 25, 5), { action: 'deposit', usd: 75 })
  assert.equal(parkPlan(28, 0, 25, 5), null) // only $3 above the buffer: not worth the gas
  assert.equal(parkPlan(25, 75, 25, 5), null) // buffer full, rest parked: nothing to do
})

test('parkPlan: a drained buffer is refilled from Aave, never more than is parked', () => {
  assert.deepEqual(parkPlan(5, 75, 25, 5), { action: 'withdraw', usd: 20 })
  assert.deepEqual(parkPlan(2, 3, 25, 5), { action: 'withdraw', usd: 3 })
  assert.equal(parkPlan(15, 75, 25, 5), null) // still above half the buffer: trades pull what they need themselves
  assert.equal(parkPlan(5, 0, 25, 5), null)
})

test('rewards: claimed only once they are worth the minimum together', () => {
  assert.equal(worthClaiming([{ usd: 0.4 }, { usd: 0.3 }], 1), false)
  assert.equal(worthClaiming([{ usd: 0.6 }, { usd: 0.5 }], 1), true)
  assert.equal(worthClaiming([], 1), false)
})
