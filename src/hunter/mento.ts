// Mento on Celo as a Peg Hunter exchange: it swaps USDm (Celo's cash token here) for each local stablecoin at the
// oracle rate plus a fixed spread, so it is the most reliable "fair price" exit there is.
// Exchanges are read from the Broker on-chain. Currencies Mento lists that the chain profile does not know yet
// (NGNm, ZARm, CADm...) are learned at discovery: symbol XXXm -> currency XXX.
// Quotes are refused while a pair is halted by a circuit breaker, its oracle is stale, or a trading limit would
// be hit: the swap would revert.
import { encodeFunctionData, erc20Abi, parseAbi, type Address, type Hex, type PublicClient } from 'viem'
import type { Venue } from '../engine.js'
import type { Token } from './chains.js'

const brokerAbi = parseAbi([
  'function tradingLimitsConfig(bytes32 id) view returns (uint32 timestep0, uint32 timestep1, int48 limit0, int48 limit1, int48 limitGlobal, uint8 flags)',
  'function tradingLimitsState(bytes32 id) view returns (uint32 lastUpdated0, uint32 lastUpdated1, int48 netflow0, int48 netflow1, int48 netflowGlobal)',
  'function getExchangeProviders() view returns (address[])',
  'function getAmountOut(address exchangeProvider, bytes32 exchangeId, address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256)',
  'function swapIn(address exchangeProvider, bytes32 exchangeId, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin) returns (uint256)',
])
const providerAbi = parseAbi([
  'function getExchanges() view returns ((bytes32 exchangeId, address[] assets)[])',
  'function getPoolExchange(bytes32 exchangeId) view returns ((address asset0, address asset1, address pricingModule, uint256 bucket0, uint256 bucket1, uint256 lastBucketUpdate, (uint256 spread, address referenceRateFeedID, uint256 referenceRateResetFrequency, uint256 minimumReports, uint256 stablePoolResetSize) config))',
  'function breakerBox() view returns (address)',
  'function sortedOracles() view returns (address)',
])
const breakerAbi = parseAbi(['function getRateFeedTradingMode(address rateFeedID) view returns (uint8)'])
const oracleAbi = parseAbi(['function isOldestReportExpired(address token) view returns (bool, address)', 'function numRates(address token) view returns (uint256)'])

type Exchange = { provider: Address; id: Hex }
export type MentoVenue = Venue & {
  pools: Map<string, number[]>
  addrs: Map<string, string[]>
  discover(tokens: string[]): Promise<number>
  learned: string[] // token keys added from the Broker, for the desk's corridor list
}

export function mentoVenue(o: {
  pub: PublicClient
  rpc: <T>(f: () => Promise<T>) => Promise<T>
  broker: Address
  T: Record<string, Token>
  toRaw: (t: string, a: bigint) => bigint
  fromRaw: (t: string, a: bigint) => bigint
  send: (to: Address, data: Hex) => Promise<{ transactionHash: Hex }>
  ensureAllowance: (t: string, spender: Address, need: bigint) => Promise<void>
}): MentoVenue {
  const { pub, broker, T } = o
  const exchanges = new Map<string, Exchange>()
  const pairKey = (a: string, b: string) => [a, b].sort().join(':')
  const keyOf = () => new Map(Object.entries(T).map(([k, t]) => [t.address.toLowerCase(), k]))
  const addrs = new Map<string, string[]>()
  const learned: string[] = []

  async function learn(address: Address): Promise<string | null> {
    const [sym, dec] = await Promise.all([
      pub.readContract({ address, abi: erc20Abi, functionName: 'symbol' }).catch(() => ''),
      pub.readContract({ address, abi: erc20Abi, functionName: 'decimals' }).catch(() => 0),
    ])
    const m = /^([A-Z]{3})m$/.exec(sym)
    if (!m || T[sym]) return null
    T[sym] = { address, decimals: Number(dec), ccy: m[1] }
    learned.push(sym)
    return sym
  }

  const OPEN_TTL = 30_000, LIMIT_TTL = 10_000
  const openCache = new Map<string, { at: number; p: Promise<string | null> }>()
  function closed(ex: Exchange): Promise<string | null> {
    const hit = openCache.get(ex.id)
    if (hit && Date.now() - hit.at < OPEN_TTL) return hit.p
    const p = (async () => {
      const { config } = await pub.readContract({ address: ex.provider, abi: providerAbi, functionName: 'getPoolExchange', args: [ex.id] })
      const feed = config.referenceRateFeedID
      const [bb, so] = await Promise.all([
        pub.readContract({ address: ex.provider, abi: providerAbi, functionName: 'breakerBox' }),
        pub.readContract({ address: ex.provider, abi: providerAbi, functionName: 'sortedOracles' }),
      ])
      const [mode, [expired], reports] = await Promise.all([
        pub.readContract({ address: bb, abi: breakerAbi, functionName: 'getRateFeedTradingMode', args: [feed] }),
        pub.readContract({ address: so, abi: oracleAbi, functionName: 'isOldestReportExpired', args: [feed] }),
        pub.readContract({ address: so, abi: oracleAbi, functionName: 'numRates', args: [feed] }),
      ])
      if (mode !== 0) return 'halted by circuit breaker'
      if (expired) return 'price feed stale'
      if (reports < config.minimumReports) return 'not enough price reports'
      return null
    })().catch(() => 'status unreadable') // unreadable counts as closed: better to miss a trade
    openCache.set(ex.id, { at: Date.now(), p })
    return p
  }

  const limitCache = new Map<string, { at: number; p: Promise<any> }>()
  function limits(ex: Exchange, t: string) {
    const id = ('0x' + (BigInt(ex.id) ^ BigInt(T[t].address)).toString(16).padStart(64, '0')) as Hex
    const hit = limitCache.get(id)
    if (hit && Date.now() - hit.at < LIMIT_TTL) return hit.p
    const p = Promise.all([
      pub.readContract({ address: broker, abi: brokerAbi, functionName: 'tradingLimitsConfig', args: [id] }),
      pub.readContract({ address: broker, abi: brokerAbi, functionName: 'tradingLimitsState', args: [id] }),
    ]).then(([cfg, st]) => ({ cfg, st })).catch(() => null)
    limitCache.set(id, { at: Date.now(), p })
    return p
  }
  async function breach(ex: Exchange, t: string, raw: bigint, into: boolean): Promise<boolean> {
    const l = await limits(ex, t)
    if (!l) return false // unreadable: the pre-send simulation is the judge
    const whole = Number(raw / 10n ** BigInt(T[t].decimals)) || (raw > 0n ? 1 : 0)
    const delta = into ? whole : -whole
    const [ts0, ts1, l0, l1, lg, flags] = l.cfg
    const [u0, u1, n0, n1, ng] = l.st
    const now = Math.floor(Date.now() / 1000)
    if (flags & 1 && Math.abs((now >= u0 + ts0 ? 0 : n0) + delta) > l0) return true
    if (flags & 2 && Math.abs((now >= u1 + ts1 ? 0 : n1) + delta) > l1) return true
    if (flags & 4 && Math.abs(ng + delta) > lg) return true
    return false
  }

  async function quoteRaw(tin: string, tout: string, amt: bigint): Promise<{ ex: Exchange; raw: bigint; out: bigint } | null> {
    const ex = exchanges.get(pairKey(tin, tout))
    if (!ex || amt <= 0n || !T[tin] || !T[tout]) return null
    if (await closed(ex)) return null
    const raw = o.toRaw(tin, amt)
    const out = await pub.readContract({ address: broker, abi: brokerAbi, functionName: 'getAmountOut', args: [ex.provider, ex.id, T[tin].address, T[tout].address, raw] })
    if ((await breach(ex, tin, raw, true)) || (await breach(ex, tout, out, false))) return null
    return { ex, raw, out }
  }

  const memo = new Map<string, { at: number; p: Promise<bigint | null> }>()
  return {
    name: 'mento',
    gas: 260_000,
    pools: new Map(),
    addrs,
    learned,
    async discover() {
      exchanges.clear(); addrs.clear()
      const providers = await pub.readContract({ address: broker, abi: brokerAbi, functionName: 'getExchangeProviders' })
      const watchTokens = new Set<string>()
      for (const provider of providers) {
        const list = await pub.readContract({ address: provider, abi: providerAbi, functionName: 'getExchanges' }).catch(() => [])
        for (const ex of list) for (const a of ex.assets) if (!keyOf().has(a.toLowerCase())) await learn(a)
        const known = keyOf()
        for (const ex of list) {
          if (ex.assets.length !== 2) continue
          const a = known.get(ex.assets[0].toLowerCase()), b = known.get(ex.assets[1].toLowerCase())
          if (!a || !b) continue
          exchanges.set(pairKey(a, b), { provider, id: ex.exchangeId })
          watchTokens.add(a); watchTokens.add(b)
        }
        const so = await pub.readContract({ address: provider, abi: providerAbi, functionName: 'sortedOracles' }).catch(() => null)
        // The Broker (swaps) and the oracles (price reports) move Mento prices: the desk rescans when they log.
        if (so) addrs.set(so.toLowerCase(), [...watchTokens])
      }
      addrs.set(broker.toLowerCase(), [...watchTokens])
      return exchanges.size
    },
    quote(tin, tout, amt) {
      const k = `${tin}>${tout}:${amt}`, hit = memo.get(k)
      if (hit && Date.now() - hit.at < 4000) return hit.p
      if (memo.size > 5000) memo.clear()
      const p = o.rpc(() => quoteRaw(tin, tout, amt)).then((q) => (q ? o.fromRaw(tout, q.out) : null)).catch(() => null)
      memo.set(k, { at: Date.now(), p })
      return p
    },
    async swap(tin, tout, amt, minOut) {
      const q = await quoteRaw(tin, tout, amt)
      if (!q) throw new Error(`Mento ${tin} -> ${tout} is closed or over its trading limit`)
      await o.ensureAllowance(tin, broker, q.raw)
      const data = encodeFunctionData({ abi: brokerAbi, functionName: 'swapIn', args: [q.ex.provider, q.ex.id, T[tin].address, T[tout].address, q.raw, o.toRaw(tout, minOut)] })
      return (await o.send(broker, data)).transactionHash
    },
  }
}
