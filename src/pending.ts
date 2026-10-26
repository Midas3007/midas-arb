// Leftover inventory from half-finished cycles, saved to disk so the loss guard survives restarts.
// Before this file existed, a restart forgot what the inventory cost and sold it at any price.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { TokenKey } from './config.js'

export type Lot = { costUsdt: string; since: number } // costUsdt as a string: JSON has no bigint

export class PendingStore {
  private lots: Partial<Record<TokenKey, Lot>> = {}
  constructor(private file: string) {
    if (existsSync(file)) {
      try { this.lots = JSON.parse(readFileSync(file, 'utf8')) } catch { this.lots = {} }
    }
  }
  private save() {
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.lots, null, 2))
    renameSync(tmp, this.file) // atomic: a crash mid-write never leaves a half-written file
  }
  get(X: TokenKey): { costUsdt: bigint; since: number } | undefined {
    const l = this.lots[X]
    return l ? { costUsdt: BigInt(l.costUsdt), since: l.since } : undefined
  }
  // Adding to an existing lot keeps the earlier start time and sums the cost.
  add(X: TokenKey, costUsdt: bigint, now = Date.now()) {
    const prev = this.get(X)
    this.lots[X] = { costUsdt: String((prev?.costUsdt ?? 0n) + costUsdt), since: prev?.since ?? now }
    this.save()
  }
  clear(X: TokenKey) {
    if (this.lots[X]) { delete this.lots[X]; this.save() }
  }
  tokens(): TokenKey[] { return Object.keys(this.lots) as TokenKey[] }
}
