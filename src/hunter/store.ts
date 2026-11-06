// Everything Peg Hunter remembers between restarts, in DATA_DIR (default ./data):
//   state.json    each chain's mode, the pause switch, sweep marks, money set aside for withdrawal
//   ledger.jsonl  one line per realized result: trades (after gas), leftovers sold, bridge and swap fees
// Profit is always computed from the ledger, never from wallet balances, so deposits never count as profit.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { DATA_DIR } from '../config.js'
import { freshState, type ChainState } from './policy.js'

export type State = {
  paused: boolean
  chains: Record<string, ChainState>
  marks: Record<string, number> // sweep high-water mark per chain (cumulative profit at its last sweep)
  reserved: Record<string, number> // dollars of the cash token kept aside for withdrawal (when swept to this wallet)
  parked: Record<string, number> // dollars put into Aave (what grows above this is interest, booked as yield)
  sweptUsd: number // everything swept so far
}

export class Store {
  state: State
  private file = `${DATA_DIR}/state.json`
  constructor(chainKeys: string[], now = Date.now()) {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    let s: Partial<State> = {}
    if (existsSync(this.file)) { try { s = JSON.parse(readFileSync(this.file, 'utf8')) } catch { s = {} } }
    const startLive = new Set((process.env.HUNTER_START_LIVE ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))
    this.state = { paused: s.paused ?? false, chains: s.chains ?? {}, marks: s.marks ?? {}, reserved: s.reserved ?? {}, parked: s.parked ?? {}, sweptUsd: s.sweptUsd ?? 0 }
    for (const k of chainKeys) if (!this.state.chains[k])
      this.state.chains[k] = startLive.has(k) ? { ...freshState('live', now, 'started live (HUNTER_START_LIVE)'), manual: true } : freshState('watch', now, 'new chain: watching first')
    this.save()
  }
  save() {
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.state, null, 2))
    renameSync(tmp, this.file) // atomic: a crash mid-write never leaves a half-written file
  }
}

export type Entry = { ts: number; chain: string; kind: 'trade' | 'flatten' | 'fee' | 'yield' | 'reward'; net: number; note?: string }

export class Ledger {
  private file = `${DATA_DIR}/ledger.jsonl`
  entries: Entry[] = []
  constructor() {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    if (existsSync(this.file)) for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      try { const e = JSON.parse(line); if (typeof e.net === 'number') this.entries.push(e) } catch { /* skip */ }
    }
  }
  add(e: Omit<Entry, 'ts'> & { ts?: number }) {
    const full: Entry = { ts: Date.now(), ...e }
    this.entries.push(full)
    appendFileSync(this.file, JSON.stringify(full) + '\n')
  }
  cum(chain: string) { return this.entries.reduce((a, e) => a + (e.chain === chain ? e.net : 0), 0) }
  since(chain: string | null, fromMs: number) {
    return this.entries.reduce((a, e) => a + ((chain === null || e.chain === chain) && e.ts >= fromMs ? e.net : 0), 0)
  }
  today(chain: string | null) {
    const d = new Date(); d.setUTCHours(0, 0, 0, 0)
    return this.since(chain, d.getTime())
  }
  trades(chain: string, fromMs: number) { return this.entries.filter((e) => e.chain === chain && e.kind === 'trade' && e.ts >= fromMs).length }
}

// One action at a time per chain: the desk's trade and the treasury's bridge never use a wallet at once.
export class Locks {
  private tails = new Map<string, Promise<void>>()
  async run<T>(key: string, f: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const mine = new Promise<void>((r) => (release = r))
    this.tails.set(key, prev.then(() => mine))
    await prev
    try { return await f() } finally { release() }
  }
}
