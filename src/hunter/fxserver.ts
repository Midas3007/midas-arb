// The FX quote API on its own (no trading): `npm run fx-api`. Finds each chain's exchanges and pools, then answers
// /fx requests and records the history (see fxapi.ts). Listens on PORT (Render sets it) or FX_API_PORT (8080).
// Chains: FX_API_CHAINS, else Celo, Base, BSC and Polygon.
import 'dotenv/config'
process.env.DESK_QUOTE_ONLY = '1'
process.env.HUNTER_LIVE = '0'
import { API_CHAINS, CHAINS } from './chains.js'
import { pruneRpcs } from './clients.js'
import { runChain, type Ctx } from './desk.js'
import { FairPrices } from './fair.js'
import { startFxApi } from './fxapi.js'
import { PegBoard } from './peg.js'
import { Ledger, Locks, Store } from './store.js'

const keys = (process.env.FX_API_CHAINS ?? API_CHAINS.join(',')).split(',').map((s) => s.trim().toLowerCase()).filter((k) => CHAINS[k])
let stopping = false
process.on('SIGINT', () => { stopping = true; process.exit(0) })
process.on('SIGTERM', () => { stopping = true; process.exit(0) })
process.on('unhandledRejection', (e: any) => console.log(`(ignored) ${String(e?.message ?? e).split('\n')[0]}`))
const ctx: Ctx = { store: new Store(keys), ledger: new Ledger(), fair: new FairPrices(), board: new PegBoard(), locks: new Locks(), live: false, status: new Map(), stopping: () => stopping, fx: new Map() }
await ctx.fair.refresh()
setInterval(() => ctx.fair.refresh().catch(() => {}), 10 * 60_000)
for (const k of keys) await pruneRpcs(CHAINS[k])
for (const k of keys) runChain(CHAINS[k], ctx).catch((e) => console.log(`[${k}] stopped: ${e?.message ?? e}`))
startFxApi(ctx, Number(process.env.PORT ?? process.env.FX_API_PORT ?? '8080'))
