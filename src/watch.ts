// React to trades instead of waiting out the timer. Every WATCH_MS the watcher asks the RPC for new blocks and
// for any log emitted by the pools the desk trades through (a swap, or liquidity added or removed: anything
// that moves a price). When one fires, the desk rescans the tokens of that pool at once. Works over plain HTTP
// (one block number + one getLogs call per tick), so it runs on the same free RPCs as before.
import type { Address, PublicClient } from 'viem'

const CHUNK = 50 // addresses per getLogs call; some RPCs cap the list
const MAX_RANGE = 200n // never ask for more blocks than this in one call

export class PoolWatcher {
  private watched = new Map<string, string[]>() // lowercase address -> tokens whose price it moves
  private last = 0n
  constructor(private pub: PublicClient, private stepMs = Number(process.env.WATCH_MS ?? '1500')) {}

  // Replace the watched set (call after each discovery). tokens: what to rescan when this address changes;
  // '*' means everything.
  set(entries: Iterable<[Address | string, string[]]>) {
    this.watched = new Map([...entries].map(([a, t]) => [a.toLowerCase(), t]))
  }
  get size() { return this.watched.size }

  // Waits until a watched address emits a log (returns the tokens to rescan) or maxMs passes (returns null).
  async wait(maxMs: number, stop: () => boolean): Promise<Set<string> | null> {
    const until = Date.now() + maxMs
    while (Date.now() < until && !stop()) {
      try {
        const bn = await this.pub.getBlockNumber({ cacheTime: 0 })
        if (this.last === 0n) this.last = bn
        if (bn > this.last && this.watched.size) {
          const from = bn - this.last > MAX_RANGE ? bn - MAX_RANGE + 1n : this.last + 1n
          const addrs = [...this.watched.keys()] as Address[]
          const hit = new Set<string>()
          for (let i = 0; i < addrs.length; i += CHUNK) {
            const logs = await this.pub.getLogs({ address: addrs.slice(i, i + CHUNK), fromBlock: from, toBlock: bn })
            for (const l of logs) for (const t of this.watched.get(l.address.toLowerCase()) ?? []) hit.add(t)
          }
          this.last = bn
          if (hit.size) return hit
        } else if (bn > this.last) this.last = bn
      } catch { /* RPC hiccup: try again next tick; the timer still forces a full scan */ }
      await new Promise((r) => setTimeout(r, Math.min(this.stepMs, Math.max(0, until - Date.now()))))
    }
    return null
  }
}
