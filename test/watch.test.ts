import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PoolWatcher } from '../src/watch.js'

// Fake RPC: block number advances each call; pool A emits a log in block 3.
function fakeChain(logBlock: bigint, addr: string) {
  let bn = 0n
  const calls: { from: bigint; to: bigint }[] = []
  return {
    calls,
    client: {
      async getBlockNumber() { return ++bn },
      async getLogs({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) {
        calls.push({ from: fromBlock, to: toBlock })
        return logBlock >= fromBlock && logBlock <= toBlock ? [{ address: addr }] : []
      },
    },
  }
}

test('watcher returns the tokens of a pool that traded, and reads each block once', async () => {
  const f = fakeChain(3n, '0xAAA')
  const w = new PoolWatcher(f.client as any, 1)
  w.set([['0xaaa', ['cNGN', 'USDT']], ['0xbbb', ['wBRL', 'USDT']]])
  const hit = await w.wait(2000, () => false)
  assert.deepEqual([...hit!].sort(), ['USDT', 'cNGN'])
  for (let i = 1; i < f.calls.length; i++) assert.equal(f.calls[i].from, f.calls[i - 1].to + 1n) // no gaps, no repeats
})

test('watcher times out with null when nothing trades, and stops when asked', async () => {
  const w = new PoolWatcher(fakeChain(999n, '0xAAA').client as any, 1)
  w.set([['0xaaa', ['cNGN']]])
  assert.equal(await w.wait(30, () => false), null)
  assert.equal(await w.wait(5000, () => true), null)
})
