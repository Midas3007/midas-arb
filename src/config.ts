import 'dotenv/config'
import type { Address } from 'viem'

// Loops House attribution tag for Agents on Open Rails, appended to every tx. Set ATTRIBUTION_TAG= (empty) to turn off.
export const ATTRIBUTION_TAG = process.env.ATTRIBUTION_TAG ?? 'celo_f6214d29d540'

export const CHAIN_ID = 42220
export const RPC_URL = process.env.CELO_RPC ?? 'https://forno.celo.org'
export const TEXTILE_API = 'https://api.textilecredit.com'

// From docs.textilecredit.com/protocol/address-book (Celo 42220)
export const TEXTILE_REACTOR: Address = '0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3'

// Uniswap v3 on Celo
export const UNI = {
  FACTORY: '0xAfE208a311B21f13EF87E33A90049fC17A7acDEc' as Address,
  QUOTER: '0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8' as Address,
  ROUTER: '0x5615CDAb10dc425a742d643d949a7F474C01abc4' as Address, // SwapRouter02
}

// Mento Broker (Celo mainnet). Exchanges and their ids are read from it on-chain at startup.
export const MENTO_BROKER = (process.env.MENTO_BROKER ?? '0x777A8255cA72412f0d706dc03C9D1987306B4CaD') as Address

// Known tokens. Discovery adds every other token Mento trades (symbol and decimals read on-chain).
export const TOKENS: Record<string, { address: Address; decimals: number }> = {
  USDT: { address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e' as Address, decimals: 6 },
  USDC: { address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C' as Address, decimals: 6 },
  CELO: { address: '0x471EcE3750Da237f93B8E339c536989b8978a438' as Address, decimals: 18 },
  cNGN: { address: '0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f' as Address, decimals: 6 },
  wBRL: { address: '0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0' as Address, decimals: 18 },
  wARS: { address: '0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D' as Address, decimals: 18 },
  // Mento stablecoins (formerly cUSD, cEUR, cREAL, cKES, eXOF, PUSO, cCOP, cGHS)
  USDm: { address: '0x765DE816845861e75A25fCA122bb6898B8B1282a' as Address, decimals: 18 },
  EURm: { address: '0xD8763CBa276a3738E6DE85b4b3bF5FDed6D6cA73' as Address, decimals: 18 },
  BRLm: { address: '0xe8537a3d056DA446677B9E9d6c5dB704EaAb4787' as Address, decimals: 18 },
  KESm: { address: '0x456a3D042C0DbD3db53D5489e98dFb038553B0d0' as Address, decimals: 18 },
  XOFm: { address: '0x73F93dcc49cB8A239e2032663e9475dd5ef29A08' as Address, decimals: 18 },
  PHPm: { address: '0x105d4A9306D2E55a71d2Eb95B81553AE1dC20d7B' as Address, decimals: 18 },
  COPm: { address: '0x8A567e2aE79CA692Bd748aB832081C45de4041eA' as Address, decimals: 18 },
  GHSm: { address: '0xfAeA5F3404bbA20D3cc2f8C4B0A888F55a3c7313' as Address, decimals: 18 },
}

export type TokenKey = string

// Tokens the desk tries to trade against USDT. Discovery keeps only those at least two venues can trade.
// Override with CORRIDORS=wBRL,BRLm,... in .env.
const ALL_CORRIDORS: TokenKey[] = ['wBRL', 'wARS', 'cNGN', 'USDm', 'EURm', 'BRLm', 'KESm', 'XOFm', 'PHPm', 'COPm', 'GHSm', 'USDC']
// Override with CORRIDORS=wBRL,BRLm,... in .env; without it, Mento currencies found at discovery are added too.
export const CORRIDORS_FIXED = !!process.env.CORRIDORS
export const CORRIDORS: TokenKey[] = CORRIDORS_FIXED
  ? process.env.CORRIDORS!.split(',').map((s) => s.trim()).filter((s) => s in TOKENS)
  : ALL_CORRIDORS

// Tokens a Uniswap route may pass through when a token has no direct pool with USDT.
export const UNI_HUBS: TokenKey[] = ['USDC', 'USDm', 'CELO']

export const VENUES = (process.env.VENUES ?? 'uniswap,textile,mento').split(',').map((s) => s.trim())
