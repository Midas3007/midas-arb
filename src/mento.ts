// Mento: Celo's oracle-priced exchange for its local stablecoins (USDm, BRLm, KESm, ...).
// Exchanges are read from the Broker on-chain, so only the Broker address is hard-coded. Mento pools are mostly
// against USDm, so a USDT trade usually goes USDT -> USDm -> X; routes take the fewest swaps (at most 3) through
// whatever exchanges exist.
import { encodeFunctionData, erc20Abi, parseAbi, type Address, type Hex } from 'viem'
import { pub, sendTagged } from './wallet.js'
import { balanceOf, ensureAllowance } from './swap.js'
import { MENTO_BROKER, TOKENS, type TokenKey } from './config.js'

const brokerAbi = parseAbi([
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
const oracleAbi = parseAbi([
  'function isOldestReportExpired(address token) view returns (bool, address)',
  'function numRates(address token) view returns (uint256)',
])

type Exchange = { provider: `0x${string}`; id: Hex }
const exchanges = new Map<string, Exchange>()
const pairOf = (a: TokenKey, b: TokenKey) => [a, b].sort().join(':')
const byAddress = new Map(Object.entries(TOKENS).map(([k, t]) => [t.address.toLowerCase(), k as TokenKey]))
// Every exchange the Broker lists, including assets the bot does not know (for `npm run mento`).
export const mentoListing: { provider: string; id: Hex; assets: string[] }[] = []

// A token Mento trades that the bot does not know yet: add it to TOKENS under its on-chain symbol.
async function learn(address: Address): Promise<TokenKey | undefined> {
  try {
    const [symbol, decimals] = await Promise.all([
      pub.readContract({ address, abi: erc20Abi, functionName: 'symbol' }),
      pub.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
    ])
    if (!/^[A-Za-z0-9]{2,12}$/.test(symbol) || symbol in TOKENS) return undefined // odd or clashing name: skip
    TOKENS[symbol] = { address, decimals }
    byAddress.set(address.toLowerCase(), symbol)
    return symbol
  } catch { return undefined }
}

// Reads every exchange from the Broker, learning tokens the bot does not know yet.
// Returns how many exchanges are usable and which tokens were newly added.
export async function mentoDiscover() {
  exchanges.clear()
  mentoListing.length = 0
  const added: TokenKey[] = []
  const providers = await pub.readContract({ address: MENTO_BROKER, abi: brokerAbi, functionName: 'getExchangeProviders' })
  for (const provider of providers) {
    const list = await pub.readContract({ address: provider, abi: providerAbi, functionName: 'getExchanges' }).catch(() => [])
    for (const ex of list) for (const a of ex.assets) {
      if (!byAddress.has(a.toLowerCase())) { const k = await learn(a); if (k) added.push(k) }
    }
    for (const ex of list) {
      mentoListing.push({ provider, id: ex.exchangeId, assets: ex.assets.map((a) => byAddress.get(a.toLowerCase()) ?? a) })
      if (ex.assets.length !== 2) continue
      const a = byAddress.get(ex.assets[0].toLowerCase()), b = byAddress.get(ex.assets[1].toLowerCase())
      if (a && b) exchanges.set(pairOf(a, b), { provider, id: ex.exchangeId })
    }
  }
  return { count: exchanges.size, added }
}

// Fewest swaps from tin to tout over the known exchanges (breadth-first, at most 3 steps).
export function mentoRoute(tin: TokenKey, tout: TokenKey): [TokenKey, TokenKey, Exchange][] | null {
  if (tin === tout) return null
  const next = new Map<TokenKey, [TokenKey, Exchange][]>()
  for (const [k, ex] of exchanges) {
    const [a, b] = k.split(':') as [TokenKey, TokenKey]
    next.set(a, [...(next.get(a) ?? []), [b, ex]])
    next.set(b, [...(next.get(b) ?? []), [a, ex]])
  }
  let paths: [TokenKey, TokenKey, Exchange][][] = [[]]
  const seen = new Set<TokenKey>([tin])
  for (let depth = 0; depth < 3; depth++) {
    const grown: [TokenKey, TokenKey, Exchange][][] = []
    for (const p of paths) {
      const at = p.length ? p[p.length - 1][1] : tin
      for (const [to, ex] of next.get(at) ?? []) {
        if (to === tout) return [...p, [at, to, ex]]
        if (!seen.has(to)) { seen.add(to); grown.push([...p, [at, to, ex]]) }
      }
    }
    paths = grown
  }
  return null
}
const route = mentoRoute

// Mento quotes keep working while a pair is closed: a circuit breaker has halted it, or its price feed is stale.
// Swaps then revert, so a quote is only trusted when the pair is open. Checked at most every 30s per exchange.
const OPEN_TTL_MS = 30_000
const openCache = new Map<string, { at: number; p: Promise<string | null> }>()
async function closedReason(ex: Exchange): Promise<string | null> {
  const { config } = await pub.readContract({ address: ex.provider, abi: providerAbi, functionName: 'getPoolExchange', args: [ex.id] })
  const feed = config.referenceRateFeedID
  const [breaker, oracles] = await Promise.all([
    pub.readContract({ address: ex.provider, abi: providerAbi, functionName: 'breakerBox' }),
    pub.readContract({ address: ex.provider, abi: providerAbi, functionName: 'sortedOracles' }),
  ])
  const [mode, [expired], reports] = await Promise.all([
    pub.readContract({ address: breaker, abi: breakerAbi, functionName: 'getRateFeedTradingMode', args: [feed] }),
    pub.readContract({ address: oracles, abi: oracleAbi, functionName: 'isOldestReportExpired', args: [feed] }),
    pub.readContract({ address: oracles, abi: oracleAbi, functionName: 'numRates', args: [feed] }),
  ])
  if (mode !== 0) return 'trading halted by circuit breaker'
  if (expired) return 'price feed is stale'
  if (reports < config.minimumReports) return 'not enough price reports'
  return null
}
// null when open; otherwise why not. A check that cannot be read counts as closed (better to miss a trade).
export function mentoClosed(ex: Exchange): Promise<string | null> {
  const k = ex.id
  const hit = openCache.get(k)
  if (hit && Date.now() - hit.at < OPEN_TTL_MS) return hit.p
  const p = closedReason(ex).catch((e) => `status unreadable (${String((e as Error).message ?? e).split('\n')[0].slice(0, 80)})`)
  openCache.set(k, { at: Date.now(), p })
  return p
}
export async function mentoRouteClosed(tin: TokenKey, tout: TokenKey): Promise<string | null> {
  const r = route(tin, tout)
  if (!r) return 'no route'
  for (const [a, b, ex] of r) { const why = await mentoClosed(ex); if (why) return `${a}/${b}: ${why}` }
  return null
}

const amountOut = (ex: Exchange, tin: TokenKey, tout: TokenKey, amt: bigint) =>
  pub.readContract({ address: MENTO_BROKER, abi: brokerAbi, functionName: 'getAmountOut', args: [ex.provider, ex.id, TOKENS[tin].address, TOKENS[tout].address, amt] })

// null when there is no route, or the quote reverts (stale oracle, trading limit reached, pool paused).
export async function mentoQuote(tin: TokenKey, tout: TokenKey, amountIn: bigint): Promise<bigint | null> {
  const r = route(tin, tout)
  if (!r || amountIn <= 0n) return null
  for (const [, , ex] of r) if (await mentoClosed(ex)) return null
  try {
    let amt = amountIn
    for (const [a, b, ex] of r) amt = await amountOut(ex, a, b, amt)
    return amt
  } catch { return null }
}

// Swaps along the route. The last step enforces minOut; a middle step accepts its quote minus slippageBps.
export async function mentoSwap(tin: TokenKey, tout: TokenKey, amountIn: bigint, minOut: bigint, slippageBps = 30n): Promise<Hex> {
  const r = route(tin, tout)
  if (!r) throw new Error(`No Mento route ${tin} -> ${tout}`)
  let amt = amountIn, hash: Hex = '0x'
  for (let i = 0; i < r.length; i++) {
    const [a, b, ex] = r[i]
    const last = i === r.length - 1
    const stepMin = last ? minOut : ((await amountOut(ex, a, b, amt)) * (10_000n - slippageBps)) / 10_000n
    await ensureAllowance(TOKENS[a].address, MENTO_BROKER, amt)
    const before = last ? 0n : await balanceOf(TOKENS[b].address)
    hash = await sendTagged({
      to: MENTO_BROKER,
      data: encodeFunctionData({ abi: brokerAbi, functionName: 'swapIn', args: [ex.provider, ex.id, TOKENS[a].address, TOKENS[b].address, amt, stepMin] }),
    })
    if (!last) {
      const { blockNumber } = await pub.getTransactionReceipt({ hash })
      amt = (await balanceOf(TOKENS[b].address, blockNumber)) - before
    }
  }
  return hash
}
