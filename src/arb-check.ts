// Read-only: compare Uniswap (Celo) cNGN price vs Textile's cNGN bid. Sends NO transactions.
import { formatUnits, parseAbi, parseUnits, type Address } from 'viem'
import { pub } from './wallet.js'
import { preview } from './textile.js'
import { TOKENS } from './config.js'

// Uniswap v3 on Celo
const FACTORY: Address = '0xAfE208a311B21f13EF87E33A90049fC17A7acDEc'
const QUOTER: Address = '0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8'
const factoryAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)'])
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)'])
const quoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)',
])

const USDT = TOKENS.USDT.address
const CNGN = TOKENS.cNGN.address
const ZERO = '0x0000000000000000000000000000000000000000'

for (const fee of [100, 500, 3000, 10000]) {
  const pool = await pub.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'getPool', args: [USDT, CNGN, fee] })
  if (pool === ZERO) { console.log(`v3 fee ${fee}: no pool`); continue }
  const [u, c] = await Promise.all([
    pub.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [pool] }),
    pub.readContract({ address: CNGN, abi: erc20, functionName: 'balanceOf', args: [pool] }),
  ])
  console.log(`\nv3 fee ${fee}: pool ${pool}\n  holds ${formatUnits(u, 6)} USDT / ${formatUnits(c, 6)} cNGN`)

  for (const usd of ['5', '20', '50']) {
    try {
      const { result } = await pub.simulateContract({
        address: QUOTER, abi: quoterAbi, functionName: 'quoteExactInputSingle',
        args: [{ tokenIn: USDT, tokenOut: CNGN, amountIn: parseUnits(usd, 6), fee, sqrtPriceLimitX96: 0n }],
      })
      const cngnOut = result[0]
      const back = await preview({ sellToken: CNGN, buyToken: USDT, sellAmount: cngnOut.toString() })
      const usdtBack = back.status === 'preview' ? Number(formatUnits(BigInt(back.buyAmount), 6)) : NaN
      const pnl = usdtBack - Number(usd)
      console.log(`  ${usd} USDT -> ${formatUnits(cngnOut, 6)} cNGN on Uniswap -> ${isNaN(usdtBack) ? `Textile ${back.reason}` : `${usdtBack.toFixed(4)} USDT on Textile  (${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)}, ${(pnl / Number(usd) * 100).toFixed(2)}%)`}`)
    } catch (e: any) {
      console.log(`  ${usd} USDT: quote failed (${e.shortMessage ?? e.message})`)
    }
  }
}
