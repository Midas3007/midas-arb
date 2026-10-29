// Chain profiles for the multi-chain desk (npm run multi -- bsc polygon).
// Each chain trades USDT against a few tokens across two Uniswap-v3-style exchanges (same quoter interface).
// Addresses are checked on startup: an exchange whose contracts are missing is dropped with a message.
// Add tokens without code changes: BSC_TOKENS=SYMBOL:0xaddress:decimals,... (POLYGON_TOKENS for Polygon).
import type { Address, Chain } from 'viem'
import { defineChain } from 'viem'
import { arbitrum, base, bsc, polygon, sei } from 'viem/chains'

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
  corridors: string[] // tokens traded against USDT (local currencies and gold are added from `extras`)
  majors: string[] // big tokens (BNB, ETH, BTC...): heavily arbitraged by fast bots, so only scanned with MULTI_MAJORS=1
  // Gold, local-currency and other real-world-asset tokens. Addresses are checked on startup: a token is used
  // only if its on-chain symbol matches one of `expect` (decimals are read on-chain), otherwise it is skipped.
  extras: Record<string, { address: Address; expect: string[] }>
  // Find tokens from the exchange's own pool list (PoolCreated logs) instead of a fixed list. cash: symbol of
  // the dollar token to trade against. Tokens whose address is not in <CHAIN>_ALLOW can only be dry-run.
  auto?: { factory: Address; blockscout: string; cash: string; maxTokens: number }
  // Uniswap v4 (one PoolManager for all pools; quotes from V4Quoter, swaps through the Universal Router with
  // Permit2). routers: candidates, the first one with code on the chain is used.
  v4?: { poolManager: Address; quoter: Address; routers: Address[]; permit2: Address }
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
const baseExtra = extraTokens(process.env.BASE_TOKENS)
const seiExtra = extraTokens(process.env.SEI_TOKENS)
const arbExtra = extraTokens(process.env.ARBITRUM_TOKENS)

const robinhoodChain = defineChain({
  id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
})

// Extra exchanges from .env, for any chain: SEI_DEXES=name|factory|quoter|router|02  (style 02 or v1), ';' between.
export const envDexes = (chainKey: string): Dex[] =>
  (process.env[`${chainKey.toUpperCase()}_DEXES`] ?? '').split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [name, factory, quoter, router, style] = s.split('|').map((x) => x.trim())
    return { name, factory: factory as Address, quoter: quoter as Address, router: router as Address,
      routerStyle: style === 'v1' ? 'v1' : '02', fees: [100, 500, 3000, 10000], gas: 190_000 } as Dex
  })

export const CHAINS: Record<string, ChainProfile> = {
  bsc: {
    key: 'bsc',
    chain: bsc,
    rpcs: list(process.env.BSC_RPCS, ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.binance.org', 'https://bsc-dataseed1.defibit.io']),
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
    corridors: list(process.env.BSC_CORRIDORS, ['USDC', 'FDUSD', ...Object.keys(bscExtra)]),
    majors: ['WBNB', 'ETH', 'BTCB', 'CAKE'],
    extras: {
      XAUT: { address: '0x21cAef8A43163Eea865baeE23b9C2E327696A3bf', expect: ['XAUT', 'XAUT0'] },   // Tether Gold
      PAXG: { address: '0x7950865a9140cB519342433146Ed5b40c6F210f7', expect: ['PAXG'] },            // Paxos Gold
      cNGN: { address: '0xa8AEA66B361a8d53e8865c62D142167Af28Af058', expect: ['CNGN'] },            // Nigerian naira
      BRZ: { address: '0x71be881e9C5d4465B3FfF61e89c6f3651E69B5bb', expect: ['BRZ'] },              // Brazilian real
      TRYB: { address: '0xC1fdbed7Dac39caE2CcC0748f7a80dC446F6a594', expect: ['TRYB'] },            // Turkish lira
      IDRX: { address: '0x649a2DA7B28E0D54c13D5eFf95d3A660652742cC', expect: ['IDRX'] },            // Indonesian rupiah
      EURI: { address: '0x9d1A7A3191102e9F900Faa10540837ba84dCBAE7', expect: ['EURI'] },            // Euro
    },
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
    rpcs: list(process.env.POLYGON_RPCS, ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com', 'https://polygon.llamarpc.com']),
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
    corridors: list(process.env.POLYGON_CORRIDORS, ['USDC', 'USDC.e', 'DAI', 'BRZ', ...Object.keys(polyExtra)]),
    majors: ['WPOL', 'WETH', 'WBTC'],
    extras: {
      PAXG: { address: '0x553d3D295e0f695B9228246232eDF400ed3560B5', expect: ['PAXG'] },            // Paxos Gold
      XAUT: { address: '0xF1815bd50389c46847f0Bda824eC8da914045D14', expect: ['XAUT', 'XAUT0'] },   // Tether Gold
      XSGD: { address: '0xDC3326e71D45186F113a2F448984CA0e8D201995', expect: ['XSGD'] },            // Singapore dollar
      EURS: { address: '0xE111178A87A3BFf0c8d18DECBa5798827539Ae99', expect: ['EURS'] },            // Euro (Stasis)
      EURe: { address: '0x18ec0A6E18E5bc3784fDd3a3634b31245ab704F6', expect: ['EURE'] },            // Euro (Monerium)
      jEUR: { address: '0x4e3Decbb3645551B8A19f0eA1678079FCB33fB4c', expect: ['JEUR'] },
      jCHF: { address: '0xbD1463F02f61676d53fd183C2B19282BFF93D099', expect: ['JCHF'] },            // Swiss franc
      jGBP: { address: '0x767058F11800FBA6A682E73A6e79ec5eB74Fac8c', expect: ['JGBP'] },            // British pound
      TRYB: { address: '0x4Fb71290Ac171E1d144F7221D882BECAc7196EB5', expect: ['TRYB'] },            // Turkish lira
      IDRX: { address: '0x649a2DA7B28E0D54c13D5eFf95d3A660652742cC', expect: ['IDRX'] },            // Indonesian rupiah
      cNGN: { address: '0x52828daa48C1a9A06F37500882b42daf0bE04C3B', expect: ['CNGN'] },            // Nigerian naira
    },
    dexes: [
      { name: 'uniswap', factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984', quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
        router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', routerStyle: '02', fees: [100, 500, 3000, 10000], gas: 180_000 },
      { name: 'sushi', factory: '0x917933899c6a5F8E37F31E19f92CdBFF7e8FF0e2', quoter: '0xb1E835Dc2785b52265711e17fCCb0fd018226a6e',
        router: '0x0aF89E1620b96170e2a9D0b68fEebb767eD044c3', routerStyle: 'v1', fees: [100, 500, 3000, 10000], gas: 190_000 },
    ],
  },
  base: {
    // Base trades mostly against USDC, so the desk's cash token ("USDT" inside the code) is USDC here.
    key: 'base',
    chain: base,
    rpcs: list(process.env.BASE_RPCS, ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base.llamarpc.com']),
    native: 'WETH',
    hubs: ['WETH', 'USDbC'],
    tokens: {
      USDT: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 }, // USDC (cash token on Base)
      USDbC: { address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', decimals: 6 },
      'USDT.b': { address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6 },
      WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18 },
      cbBTC: { address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8 },
      ...baseExtra,
    },
    corridors: list(process.env.BASE_CORRIDORS, ['USDbC', 'USDT.b', ...Object.keys(baseExtra)]),
    majors: ['WETH', 'cbBTC'],
    extras: {
      EURC: { address: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', expect: ['EURC'] },            // Euro (Circle)
      cNGN: { address: '0x46C85152bFe9f96829aA94755D9f915F9B10EF5F', expect: ['CNGN'] },            // Nigerian naira
      IDRX: { address: '0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22', expect: ['IDRX'] },            // Indonesian rupiah
      CADC: { address: '0x043eB4B75d0805c43D7C834902E335621983Cf03', expect: ['CADC'] },            // Canadian dollar
      BRZ: { address: '0xE9185Ee218cae427aF7B9764A011bb89FeA761B4', expect: ['BRZ'] },              // Brazilian real
      ZARP: { address: '0xb755506531786C8aC63B756BaB1ac387bACB0C04', expect: ['ZARP'] },            // South African rand
      MXNe: { address: '0x269caE7Dc59803e5C596c95756faEeBb6030E0aF', expect: ['MXNE'] },            // Mexican peso
      XAUT: { address: '0x68749665FF8D2d112Fa859AA293F07A622782F38', expect: ['XAUT', 'XAUT0'] },   // Tether Gold
    },
    dexes: [
      { name: 'uniswap', factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
        router: '0x2626664c2603336E57B271c5C0b26F421741e481', routerStyle: '02', fees: [100, 500, 3000, 10000], gas: 180_000 },
      { name: 'pancake', factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
        router: '0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86', routerStyle: '02', fees: [100, 500, 2500, 10000], gas: 180_000 },
      { name: 'sushi', factory: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4', quoter: '0xb1E835Dc2785b52265711e17fCCb0fd018226a6e',
        router: '0xFB7eF66a7e61224DD6FcD0D7d9C3be5C8B049b9f', routerStyle: 'v1', fees: [100, 500, 3000, 10000], gas: 190_000 },
    ],
  },
  sei: {
    // Sei EVM. Cash token is USDC ("USDT" inside the code). More exchanges can be added with SEI_DEXES (.env.example).
    key: 'sei',
    chain: sei,
    rpcs: list(process.env.SEI_RPCS, ['https://evm-rpc.sei-apis.com']),
    native: 'WSEI',
    hubs: ['WSEI', 'USDT0'],
    tokens: {
      USDT: { address: '0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392', decimals: 6 }, // USDC (cash token on Sei)
      USDT0: { address: '0x9151434b16b9763660705744891fA906F660EcC5', decimals: 6 },
      WSEI: { address: '0xE30feDd158A2e3b13e9badaeABaFc5516e95e8C7', decimals: 18 },
      ...seiExtra,
    },
    corridors: list(process.env.SEI_CORRIDORS, ['USDT0', ...Object.keys(seiExtra)]),
    majors: ['WSEI'],
    extras: {
      iSEI: { address: '0x5Cf6826140C1C56Ff49C808A1A75407Cd1DF9423', expect: ['ISEI'] },             // liquid-staked SEI
      USDY: { address: '0x54cD901491AeF397084453F4372B93c33260e2A6', expect: ['USDY'] },             // Ondo US Treasuries (RWA)
      'USDC.ibc': { address: '0xB75D0B03c06A926e488e2659DF1A861F860bD3d1', expect: ['USDC', 'USDCIBC', 'IBCUSDC', 'USDCE'] },
      'USDC.n': { address: '0x3894085Ef7Ff0f0aeDf52E2A2704928d1Ec074F1', expect: ['USDC', 'USDCN', 'NUSDC', 'NOBLEUSDC'] },
      // Majors elsewhere, but Sei has far fewer arbitrage bots, so scanned by default here
      WBTC: { address: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c', expect: ['WBTC'] },
      WETH: { address: '0x160345fC359604fC6e70E3c5fAcbdE5F7A9342d8', expect: ['WETH'] },
    },
    dexes: [
      // DragonSwap V2 (from docs.dragonswap.app "Contract Addresses > DEX V2")
      { name: 'dragon', factory: '0x179d9a5592bc77050796f7be28058c51ca575df4', quoter: '0x38f759cf0af1d0dcaed723a3967a3b658738ede9',
        router: '0x11da6463d6cb5a03411dbf5ab6f6bc3997ac7428', routerStyle: '02', fees: [100, 500, 2500, 3000, 10000], gas: 190_000 },
      // Uniswap v3 on Sei, deployed by Oku (from docs.oku.trade)
      { name: 'uniswap', factory: '0x75fc67473a91335b5b8f8821277262a13b38c9b3', quoter: '0x807f4e281b7a3b324825c64ca53c69f0b418de40',
        router: '0xdd489c75be1039ec7d843a6ac2fd658350b067cf', routerStyle: '02', fees: [100, 500, 3000, 10000], gas: 180_000 },
    ],
  },
  arbitrum: {
    // Arbitrum One. Robinhood's tokenized stocks also live here: add them with ARBITRUM_TOKENS=SYMBOL:0x..:decimals.
    key: 'arbitrum',
    chain: arbitrum,
    rpcs: list(process.env.ARBITRUM_RPCS, ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc', 'https://arbitrum.llamarpc.com']),
    native: 'WETH',
    hubs: ['WETH', 'USDC'],
    tokens: {
      USDT: { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
      USDC: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
      'USDC.e': { address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', decimals: 6 },
      DAI: { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18 },
      WETH: { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 },
      WBTC: { address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', decimals: 8 },
      ARB: { address: '0x912CE59144191C1204E64559FE8253a0e49E6548', decimals: 18 },
      ...arbExtra,
    },
    corridors: list(process.env.ARBITRUM_CORRIDORS, ['USDC', 'USDC.e', 'DAI', ...Object.keys(arbExtra)]),
    majors: ['WETH', 'WBTC', 'ARB'],
    extras: {
      XAUT: { address: '0x40461291347e1eCbb09499F3371D3f17f10d7159', expect: ['XAUT', 'XAUT0'] },   // Tether Gold
      PAXG: { address: '0xfEb4DfC8C4Cf7Ed305bb08065D08eC6ee6728429', expect: ['PAXG'] },            // Paxos Gold
      EURe: { address: '0x0c06cCF38114ddfc35e07427B9424adcca9F44F8', expect: ['EURE'] },            // Euro (Monerium)
    },
    dexes: [
      { name: 'uniswap', factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984', quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
        router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', routerStyle: '02', fees: [100, 500, 3000, 10000], gas: 200_000 },
      { name: 'pancake', factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
        router: '0x32226588378236Fd0c7c4053999F88aC0e5cAc77', routerStyle: '02', fees: [100, 500, 2500, 10000], gas: 200_000 },
      { name: 'sushi', factory: '0x1af415a1EbA07a4986a52B6f2e7dE7003D82231e', quoter: '0x0524E833cCD057e4d7A296e3aaAb9f7675964Ce1',
        router: '0x8A21F6768C1f8075791D08546Dadf6daA0bE820c', routerStyle: 'v1', fees: [100, 500, 3000, 10000], gas: 210_000 },
    ],
  },
  robinhood: {
    // Robinhood Chain (Arbitrum Orbit L2, chain 4663). Tokens, including Robinhood's tokenized stocks, are found
    // from Uniswap v3's pool list at startup. Copycat tokens with the same ticker exist: only addresses listed in
    // ROBINHOOD_ALLOW (comma separated, from Robinhood's official Stock Token registry) can trade live.
    key: 'robinhood',
    chain: robinhoodChain,
    rpcs: list(process.env.ROBINHOOD_RPCS, ['https://rpc.mainnet.chain.robinhood.com']),
    native: 'WETH',
    hubs: ['WETH'],
    tokens: {},
    corridors: [],
    majors: [],
    extras: {},
    auto: { factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa', blockscout: 'https://robinhoodchain.blockscout.com', cash: process.env.ROBINHOOD_CASH ?? 'USDG', maxTokens: Number(process.env.ROBINHOOD_MAX_TOKENS ?? '40') },
    v4: { // developers.uniswap.org v4 deployments; the Universal Router was redeployed on 2026-07-06 (Uniswap/docs#1161)
      poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951', quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
      routers: ['0x06afBA43fd06227fA663b0dAeCF536F6eaA6BF99', '0x8876789976decbfcbbbe364623c63652db8c0904'],
      permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    },
    dexes: [
      // Uniswap v3 on Robinhood Chain (developers.uniswap.org, v3 deployments)
      { name: 'uniswap', factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa', quoter: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',
        router: '0xcaf681a66d020601342297493863e78c959e5cb2', routerStyle: '02', fees: [100, 500, 3000, 10000], gas: 200_000 },
    ],
  },
}
