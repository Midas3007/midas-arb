// Chain profiles for Peg Hunter. Only cheap-gas EVM chains: a swap must cost under MAX_SWAP_GAS_USD (default
// $0.01), which the desk checks live before a chain may trade.
//
// Each chain trades one dollar "cash" token (called USDT inside the code, whatever it really is: USDm on Celo,
// USDC on Base...) against currency-pegged stablecoins. Every stablecoin is in a hand-checked list with its
// official address and its currency. On startup each address is read on-chain and used only if its symbol is
// one of `expect`: a wrong or copycat address is skipped, never traded.
//
// Exchanges are Uniswap-v3-style (same factory/quoter/router interface). Their contracts are checked on startup
// too: an exchange whose contracts are missing is dropped with a message.
import type { Address, Chain } from 'viem'
import { arbitrum, avalanche, base, bsc, celo, gnosis, optimism, polygon, sei } from 'viem/chains'

export type Dex = {
  name: string
  kind?: 'v3' | 'slipstream' // slipstream (Aerodrome/Velodrome concentrated pools): pools are keyed by tick spacing, not fee
  factory: Address
  quoter: Address // QuoterV2: quoteExactInput
  router: Address
  routerStyle: '02' | 'v1' // '02' = SwapRouter02 params (no deadline); 'v1' = original SwapRouter (with deadline)
  fees: number[]
  gas: number
}
// ccy: the currency the token is pegged to (ISO code). Tokens without one (WETH...) are only used as hubs.
export type Token = { address: Address; decimals: number; ccy?: string }
export type Peg = { address: Address; expect: string[]; ccy: string }
export type ChainProfile = {
  key: string
  chain: Chain
  rpcs: string[]
  cashName: string // what the cash token really is, for messages
  native: string // key of the wrapped gas token in `tokens`, used to price gas
  minGas: string // below this much native gas the chain counts as empty
  lifiNative?: Address // LI.FI's address for the gas token when it is not 0x000…0 (Celo)
  hubs: string[] // tokens a route may pass through
  tokens: Record<string, Token> // must include USDT (the cash token)
  pegs: Record<string, Peg> // currency-pegged stablecoins, checked on startup
  solidly?: { name: string; router: Address; factory: Address }[] // Aerodrome/Velodrome classic stable + volatile pools
  curve?: string // Curve's API name for the chain: its pools are found there
  aave?: Address // Aave v3 Pool: idle cash earns interest here between trades
  mento?: { broker: Address; hub: string } // Celo: Mento, oracle-priced exchange; trades `hub` (USDm) for each currency
  textile?: { api: string; reactor: Address } // Celo: Textile FX, RFQ market makers quoting at real FX rates
  dexes: Dex[]
}

const list = (env: string | undefined, dflt: string[]) => (env ? env.split(',').map((s) => s.trim()).filter(Boolean) : dflt)
// Extra stablecoins without code changes: BASE_PEGS=SYMBOL:0xaddress:CCY,... (symbol is also what must match on-chain)
const envPegs = (key: string): Record<string, Peg> =>
  Object.fromEntries((process.env[`${key.toUpperCase()}_PEGS`] ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [sym, address, ccy] = s.split(':')
    return [sym, { address: address as Address, expect: [sym.toUpperCase().replace(/[^A-Z0-9]/g, '')], ccy: (ccy ?? 'USD').toUpperCase() }]
  }))
// Extra exchanges from .env, for any chain: BASE_DEXES=name|factory|quoter|router|02  (style 02 or v1), ';' between.
export const envDexes = (chainKey: string): Dex[] =>
  (process.env[`${chainKey.toUpperCase()}_DEXES`] ?? '').split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [name, factory, quoter, router, style] = s.split('|').map((x) => x.trim())
    return { name, factory: factory as Address, quoter: quoter as Address, router: router as Address,
      routerStyle: style === 'v1' ? 'v1' : '02', fees: [100, 500, 3000, 10000], gas: 190_000 } as Dex
  })
const peg = (address: string, ccy: string, ...expect: string[]): Peg => ({ address: address as Address, ccy, expect })
const uniV3 = (factory: string, quoter: string, router: string, gas = 180_000): Dex => ({
  name: 'uniswap', factory: factory as Address, quoter: quoter as Address, router: router as Address, routerStyle: '02', fees: [100, 500, 3000, 10000], gas,
})

const slipstream = (name: string, factory: string, quoter: string, router: string): Dex => ({
  name, kind: 'slipstream', factory: factory as Address, quoter: quoter as Address, router: router as Address, routerStyle: 'v1', fees: [1, 50, 100, 200, 2000], gas: 200_000,
})

export const CHAINS: Record<string, ChainProfile> = {
  celo: {
    // Cash is USDT (as in Kiyoshi). Textile quotes cNGN, wBRL, wARS... against USDT at real FX rates. Mento trades
    // every local currency against USDm at the oracle rate; it is reached through Uniswap's deep USDT/USDm pool.
    key: 'celo', chain: celo,
    rpcs: list(process.env.CELO_RPCS, ['https://forno.celo.org', 'https://celo-rpc.publicnode.com']),
    cashName: 'USDT', native: 'CELO', minGas: '0.5', lifiNative: '0x471EcE3750Da237f93B8E339c536989b8978a438',
    hubs: ['USDm', 'USDC', 'CELO'],
    tokens: {
      USDT: { address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e', decimals: 6, ccy: 'USD' },
      USDm: { address: '0x765DE816845861e75A25fCA122bb6898B8B1282a', decimals: 18, ccy: 'USD' },
      USDC: { address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', decimals: 6, ccy: 'USD' },
      CELO: { address: '0x471EcE3750Da237f93B8E339c536989b8978a438', decimals: 18 },
    },
    pegs: {
      cNGN: peg('0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f', 'NGN', 'CNGN'),
      wBRL: peg('0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0', 'BRL', 'WBRL', 'BRL'),
      wARS: peg('0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D', 'ARS', 'WARS', 'ARS'),
      EURm: peg('0xD8763CBa276a3738E6DE85b4b3bF5FDed6D6cA73', 'EUR', 'EURM', 'CEUR'),
      BRLm: peg('0xe8537a3d056DA446677B9E9d6c5dB704EaAb4787', 'BRL', 'BRLM', 'CREAL'),
      KESm: peg('0x456a3D042C0DbD3db53D5489e98dFb038553B0d0', 'KES', 'KESM', 'CKES'),
      XOFm: peg('0x73F93dcc49cB8A239e2032663e9475dd5ef29A08', 'XOF', 'XOFM', 'EXOF'),
      PHPm: peg('0x105d4A9306D2E55a71d2Eb95B81553AE1dC20d7B', 'PHP', 'PHPM', 'PUSO'),
      COPm: peg('0x8A567e2aE79CA692Bd748aB832081C45de4041eA', 'COP', 'COPM', 'CCOP'),
      GHSm: peg('0xfAeA5F3404bbA20D3cc2f8C4B0A888F55a3c7313', 'GHS', 'GHSM', 'CGHS'),
      ...envPegs('celo'),
    },
    // Every other currency Mento lists (NGNm, ZARm, CADm, AUDm...) is added from Mento's Broker at startup.
    mento: { broker: (process.env.MENTO_BROKER ?? '0x777A8255cA72412f0d706dc03C9D1987306B4CaD') as Address, hub: 'USDm' },
    // docs.textilecredit.com/protocol/address-book (Celo 42220)
    textile: { api: process.env.TEXTILE_API ?? 'https://api.textilecredit.com', reactor: '0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3' },
    curve: 'celo', aave: '0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402',
    dexes: [uniV3('0xAfE208a311B21f13EF87E33A90049fC17A7acDEc', '0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8', '0x5615CDAb10dc425a742d643d949a7F474C01abc4', 200_000)],
  },
  base: {
    key: 'base', chain: base,
    rpcs: list(process.env.BASE_RPCS, ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base.llamarpc.com']),
    cashName: 'USDC', native: 'WETH', minGas: '0.0001',
    hubs: ['WETH', 'USDbC'],
    tokens: {
      USDT: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, ccy: 'USD' }, // USDC (cash)
      USDbC: { address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', decimals: 6, ccy: 'USD' },
      'USDT.b': { address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6, ccy: 'USD' },
      WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18 },
    },
    pegs: {
      EURC: peg('0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', 'EUR', 'EURC'),
      cNGN: peg('0x46C85152bFe9f96829aA94755D9f915F9B10EF5F', 'NGN', 'CNGN'),
      IDRX: peg('0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22', 'IDR', 'IDRX'),
      CADC: peg('0x043eB4B75d0805c43D7C834902E335621983Cf03', 'CAD', 'CADC'),
      BRZ: peg('0xE9185Ee218cae427aF7B9764A011bb89FeA761B4', 'BRL', 'BRZ'),
      ZARP: peg('0xb755506531786C8aC63B756BaB1ac387bACB0C04', 'ZAR', 'ZARP'),
      MXNe: peg('0x269caE7Dc59803e5C596c95756faEeBb6030E0aF', 'MXN', 'MXNE'),
      ...envPegs('base'),
    },
    curve: 'base', aave: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    solidly: [{ name: 'aerodrome-v2', router: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43', factory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da' }],
    dexes: [
      uniV3('0x33128a8fC17869897dcE68Ed026d694621f6FDfD', '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a', '0x2626664c2603336E57B271c5C0b26F421741e481'),
      slipstream('aerodrome', '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A', '0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0', '0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5'),
      { name: 'pancake', factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
        router: '0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86', routerStyle: '02', fees: [100, 500, 2500, 10000], gas: 180_000 },
      { name: 'sushi', factory: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4', quoter: '0xb1E835Dc2785b52265711e17fCCb0fd018226a6e',
        router: '0xFB7eF66a7e61224DD6FcD0D7d9C3be5C8B049b9f', routerStyle: 'v1', fees: [100, 500, 3000, 10000], gas: 190_000 },
    ],
  },
  bsc: {
    key: 'bsc', chain: bsc,
    rpcs: list(process.env.BSC_RPCS, ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.binance.org', 'https://bsc-dataseed1.defibit.io']),
    cashName: 'USDT', native: 'WBNB', minGas: '0.0005',
    hubs: ['WBNB', 'USDC'],
    tokens: {
      USDT: { address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18, ccy: 'USD' },
      USDC: { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18, ccy: 'USD' },
      FDUSD: { address: '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409', decimals: 18, ccy: 'USD' },
      WBNB: { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18 },
    },
    pegs: {
      cNGN: peg('0xa8AEA66B361a8d53e8865c62D142167Af28Af058', 'NGN', 'CNGN'),
      BRZ: peg('0x71be881e9C5d4465B3FfF61e89c6f3651E69B5bb', 'BRL', 'BRZ'),
      TRYB: peg('0xC1fdbed7Dac39caE2CcC0748f7a80dC446F6a594', 'TRY', 'TRYB'),
      IDRX: peg('0x649a2DA7B28E0D54c13D5eFf95d3A660652742cC', 'IDR', 'IDRX'),
      EURI: peg('0x9d1A7A3191102e9F900Faa10540837ba84dCBAE7', 'EUR', 'EURI'),
      ...envPegs('bsc'),
    },
    curve: 'bsc', aave: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
    dexes: [
      { name: 'pancake', factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
        router: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4', routerStyle: '02', fees: [100, 500, 2500, 10000], gas: 180_000 },
      uniV3('0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7', '0x78D78E420Da98ad378D7799bE8f4AF69033EB077', '0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2'),
    ],
  },
  polygon: {
    key: 'polygon', chain: polygon,
    rpcs: list(process.env.POLYGON_RPCS, ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com', 'https://polygon.llamarpc.com']),
    cashName: 'USDT', native: 'WPOL', minGas: '0.5',
    hubs: ['WPOL', 'USDC'],
    tokens: {
      USDT: { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6, ccy: 'USD' },
      USDC: { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6, ccy: 'USD' },
      'USDC.e': { address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', decimals: 6, ccy: 'USD' },
      DAI: { address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', decimals: 18, ccy: 'USD' },
      WPOL: { address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', decimals: 18 },
    },
    pegs: {
      BRZ: peg('0x4eD141110F6EeeAbA9A1df36d8c26f684d2475Dc', 'BRL', 'BRZ'),
      XSGD: peg('0xDC3326e71D45186F113a2F448984CA0e8D201995', 'SGD', 'XSGD'),
      EURS: peg('0xE111178A87A3BFf0c8d18DECBa5798827539Ae99', 'EUR', 'EURS'),
      EURe: peg('0x18ec0A6E18E5bc3784fDd3a3634b31245ab704F6', 'EUR', 'EURE'),
      jEUR: peg('0x4e3Decbb3645551B8A19f0eA1678079FCB33fB4c', 'EUR', 'JEUR'),
      jCHF: peg('0xbD1463F02f61676d53fd183C2B19282BFF93D099', 'CHF', 'JCHF'),
      jGBP: peg('0x767058F11800FBA6A682E73A6e79ec5eB74Fac8c', 'GBP', 'JGBP'),
      TRYB: peg('0x4Fb71290Ac171E1d144F7221D882BECAc7196EB5', 'TRY', 'TRYB'),
      IDRX: peg('0x649a2DA7B28E0D54c13D5eFf95d3A660652742cC', 'IDR', 'IDRX'),
      cNGN: peg('0x52828daa48C1a9A06F37500882b42daf0bE04C3B', 'NGN', 'CNGN'),
      ...envPegs('polygon'),
    },
    curve: 'polygon', aave: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    dexes: [
      uniV3('0x1F98431c8aD98523631AE4a59f267346ea31F984', '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'),
      { name: 'sushi', factory: '0x917933899c6a5F8E37F31E19f92CdBFF7e8FF0e2', quoter: '0xb1E835Dc2785b52265711e17fCCb0fd018226a6e',
        router: '0x0aF89E1620b96170e2a9D0b68fEebb767eD044c3', routerStyle: 'v1', fees: [100, 500, 3000, 10000], gas: 190_000 },
    ],
  },
  arbitrum: {
    key: 'arbitrum', chain: arbitrum,
    rpcs: list(process.env.ARBITRUM_RPCS, ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc', 'https://arbitrum.llamarpc.com']),
    cashName: 'USDT', native: 'WETH', minGas: '0.0001',
    hubs: ['WETH', 'USDC'],
    tokens: {
      USDT: { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6, ccy: 'USD' },
      USDC: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6, ccy: 'USD' },
      'USDC.e': { address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', decimals: 6, ccy: 'USD' },
      DAI: { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18, ccy: 'USD' },
      WETH: { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 },
    },
    pegs: {
      EURe: peg('0x0c06cCF38114ddfc35e07427B9424adcca9F44F8', 'EUR', 'EURE'),
      ...envPegs('arbitrum'),
    },
    curve: 'arbitrum', aave: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    dexes: [
      uniV3('0x1F98431c8aD98523631AE4a59f267346ea31F984', '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', 200_000),
      { name: 'pancake', factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
        router: '0x32226588378236Fd0c7c4053999F88aC0e5cAc77', routerStyle: '02', fees: [100, 500, 2500, 10000], gas: 200_000 },
      { name: 'sushi', factory: '0x1af415a1EbA07a4986a52B6f2e7dE7003D82231e', quoter: '0x0524E833cCD057e4d7A296e3aaAb9f7675964Ce1',
        router: '0x8A21F6768C1f8075791D08546Dadf6daA0bE820c', routerStyle: 'v1', fees: [100, 500, 3000, 10000], gas: 210_000 },
    ],
  },
  optimism: {
    key: 'optimism', chain: optimism,
    rpcs: list(process.env.OPTIMISM_RPCS, ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io']),
    cashName: 'USDC', native: 'WETH', minGas: '0.0001',
    hubs: ['WETH', 'USDT.o'],
    tokens: {
      USDT: { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6, ccy: 'USD' }, // USDC (cash)
      'USDT.o': { address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6, ccy: 'USD' },
      'USDC.e': { address: '0x7F5c764cBc14f9669B88837ca1490cCa17c31607', decimals: 6, ccy: 'USD' },
      DAI: { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18, ccy: 'USD' },
      WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18 },
    },
    pegs: {
      sUSD: peg('0x8c6f28f2F1A3C87F0f938b96d27520d9751ec8d9', 'USD', 'SUSD'),
      EURA: peg('0x9485aca5bbBE1667AD97c7fE7C4531a624C8b1ED', 'EUR', 'EURA', 'AGEUR'),
      ...envPegs('optimism'),
    },
    curve: 'optimism', aave: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    solidly: [{ name: 'velodrome-v2', router: '0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858', factory: '0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a' }],
    dexes: [
      uniV3('0x1F98431c8aD98523631AE4a59f267346ea31F984', '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'),
      slipstream('velodrome', '0xCc0bDDB707055e04e497aB22a59c2aF4391cd12F', '0x89D8218ed5fF1e46d8dcd33fb0bbeE3be1621466', '0x0792a633F0c19c351081CF4B211F68F79bCc9676'),
    ],
  },
  avalanche: {
    key: 'avalanche', chain: avalanche,
    rpcs: list(process.env.AVALANCHE_RPCS, ['https://avalanche-c-chain-rpc.publicnode.com', 'https://api.avax.network/ext/bc/C/rpc']),
    cashName: 'USDC', native: 'WAVAX', minGas: '0.02',
    hubs: ['WAVAX', 'USDT.a'],
    tokens: {
      USDT: { address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', decimals: 6, ccy: 'USD' }, // USDC (cash)
      'USDT.a': { address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', decimals: 6, ccy: 'USD' },
      'USDC.e': { address: '0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664', decimals: 6, ccy: 'USD' },
      WAVAX: { address: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', decimals: 18 },
    },
    pegs: {
      EURC: peg('0xC891EB4cbdEFf6e073e859e987815Ed1505c2ACD', 'EUR', 'EURC'),
      ...envPegs('avalanche'),
    },
    curve: 'avalanche', aave: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    dexes: [uniV3('0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD', '0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F', '0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE')],
  },
  gnosis: {
    // Cash is WXDAI (wrapped xDAI, the chain's own dollar). Monerium's EURe and GBPe live here.
    key: 'gnosis', chain: gnosis,
    rpcs: list(process.env.GNOSIS_RPCS, ['https://gnosis-rpc.publicnode.com', 'https://rpc.gnosischain.com']),
    cashName: 'WXDAI', native: 'USDT', minGas: '0.2',
    hubs: ['USDC.e'],
    tokens: {
      USDT: { address: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d', decimals: 18, ccy: 'USD' }, // WXDAI (cash)
      'USDC.e': { address: '0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0', decimals: 6, ccy: 'USD' },
    },
    pegs: {
      EURe: peg('0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430', 'EUR', 'EURE'),
      GBPe: peg('0x8E34bfEC4f6Eb781f9743D9b4af99CD23F9b7053', 'GBP', 'GBPE'),
      ...envPegs('gnosis'),
    },
    curve: 'xdai', aave: '0xb50201558B00496A145fE76f7424749556E326D8',
    dexes: [uniV3('0xe32F7dD7e3f098D518ff19A22d5f028e076489B1', '0x7E9cB3499A6cee3baBe5c8a3D328EA7FD36578f4', '0xc6D25285D5C5b62b7ca26D6092751A145D50e9Be')],
  },
  sei: {
    // Sei EVM. Cash is USDC. More exchanges can be added with SEI_DEXES (.env.example).
    key: 'sei', chain: sei,
    rpcs: list(process.env.SEI_RPCS, ['https://evm-rpc.sei-apis.com']),
    cashName: 'USDC', native: 'WSEI', minGas: '0.5',
    hubs: ['WSEI', 'USDT0'],
    tokens: {
      USDT: { address: '0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392', decimals: 6, ccy: 'USD' }, // USDC (cash)
      USDT0: { address: '0x9151434b16b9763660705744891fA906F660EcC5', decimals: 6, ccy: 'USD' },
      WSEI: { address: '0xE30feDd158A2e3b13e9badaeABaFc5516e95e8C7', decimals: 18 },
    },
    pegs: {
      'USDC.n': peg('0x3894085Ef7Ff0f0aeDf52E2A2704928d1Ec074F1', 'USD', 'USDC', 'USDCN', 'NUSDC', 'NOBLEUSDC'),
      ...envPegs('sei'),
    },
    dexes: [
      { name: 'dragon', factory: '0x179d9a5592bc77050796f7be28058c51ca575df4', quoter: '0x38f759cf0af1d0dcaed723a3967a3b658738ede9',
        router: '0x11da6463d6cb5a03411dbf5ab6f6bc3997ac7428', routerStyle: '02', fees: [100, 500, 2500, 3000, 10000], gas: 190_000 },
      uniV3('0x75fc67473a91335b5b8f8821277262a13b38c9b3', '0x807f4e281b7a3b324825c64ca53c69f0b418de40', '0xdd489c75be1039ec7d843a6ac2fd658350b067cf'),
    ],
  },
}

// Which chains run: HUNTER_CHAINS=celo,base,... (default: all of them).
export const chainKeys = (): string[] => list(process.env.HUNTER_CHAINS, Object.keys(CHAINS)).map((s) => s.toLowerCase())
