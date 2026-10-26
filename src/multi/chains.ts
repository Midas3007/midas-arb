// Chain profiles for the multi-chain desk (npm run multi -- bsc polygon).
// Each chain trades USDT against a few tokens across two Uniswap-v3-style exchanges (same quoter interface).
// Addresses are checked on startup: an exchange whose contracts are missing is dropped with a message.
// Add tokens without code changes: BSC_TOKENS=SYMBOL:0xaddress:decimals,... (POLYGON_TOKENS for Polygon).
import type { Address, Chain } from 'viem'
import { bsc, polygon } from 'viem/chains'

export type Dex = {
  name: string
  factory: Address
  quoter: Address // QuoterV2: quoteExactInputSingle / quoteExactInput
  router: Address
  routerStyle: '02' | 'v1' // '02' = SwapRouter02 params (no deadline); 'v1' = original SwapRouter (with deadline)
  fees: number[]
  gas: number
}
export type Token = { address: Address; decimals: number }
export type ChainProfile = {
  key: string
  chain: Chain
  rpcs: string[]
  native: string // symbol of the wrapped gas token in `tokens`, used to price gas
  hubs: string[] // tokens a route may pass through
  tokens: Record<string, Token> // must include USDT
  corridors: string[] // tokens traded against USDT
  dexes: Dex[]
}

const extraTokens = (env: string | undefined): Record<string, Token> =>
  Object.fromEntries((env ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [sym, address, dec] = s.split(':')
    return [sym, { address: address as Address, decimals: Number(dec) }]
  }))
const list = (env: string | undefined, dflt: string[]) => (env ? env.split(',').map((s) => s.trim()).filter(Boolean) : dflt)

const bscExtra = extraTokens(process.env.BSC_TOKENS)
const polyExtra = extraTokens(process.env.POLYGON_TOKENS)

export const CHAINS: Record<string, ChainProfile> = {
  bsc: {
    key: 'bsc',
    chain: bsc,
    rpcs: list(process.env.BSC_RPCS, ['https://bsc-dataseed.binance.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc.publicnode.com']),
    native: 'WBNB',
    hubs: ['WBNB', 'USDC'],
    tokens: {
      USDT: { address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
      USDC: { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
      FDUSD: { address: '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409', decimals: 18 },
      WBNB: { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18 },
      ETH: { address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', decimals: 18 },
      BTCB: { address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', decimals: 18 },
      CAKE: { address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', decimals: 18 },
      ...bscExtra,
    },
    corridors: list(process.env.BSC_CORRIDORS, ['USDC', 'FDUSD', 'WBNB', 'ETH', 'BTCB', 'CAKE', ...Object.keys(bscExtra)]),
    dexes: [
      { name: 'pancake', factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
        router: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4', routerStyle: '02', fees: [100, 500, 2500, 10000], gas: 180_000 },
      { name: 'uniswap', factory: '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7', quoter: '0x78D78E420Da98ad378D7799bE8f4AF69033EB077',
        router: '0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2', routerStyle: '02', fees: [100, 500, 3000, 10000], gas: 180_000 },
    ],
  },
  polygon: {
    key: 'polygon',
    chain: polygon,
    rpcs: list(process.env.POLYGON_RPCS, ['https://polygon-rpc.com', 'https://polygon.publicnode.com', 'https://polygon.llamarpc.com']),
    native: 'WPOL',
    hubs: ['WPOL', 'USDC'],
    tokens: {
      USDT: { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
      USDC: { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
      'USDC.e': { address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', decimals: 6 },
      DAI: { address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', decimals: 18 },
      WPOL: { address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', decimals: 18 },
      WETH: { address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', decimals: 18 },
      WBTC: { address: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', decimals: 8 },
      BRZ: { address: '0x4eD141110F6EeeAbA9A1df36d8c26f684d2475Dc', decimals: 18 },
      ...polyExtra,
    },
    corridors: list(process.env.POLYGON_CORRIDORS, ['USDC', 'USDC.e', 'DAI', 'WPOL', 'WETH', 'WBTC', 'BRZ', ...Object.keys(polyExtra)]),
    dexes: [
      { name: 'uniswap', factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984', quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
        router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', routerStyle: '02', fees: [100, 500, 3000, 10000], gas: 180_000 },
      { name: 'sushi', factory: '0x917933899c6a5F8E37F31E19f92CdBFF7e8FF0e2', quoter: '0xb1E835Dc2785b52265711e17fCCb0fd018226a6e',
        router: '0x0aF89E1620b96170e2a9D0b68fEebb767eD044c3', routerStyle: 'v1', fees: [100, 500, 3000, 10000], gas: 190_000 },
    ],
  },
}
