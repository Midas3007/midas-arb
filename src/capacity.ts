// Read-only: how much cNGN can be sold into the Uniswap pool before it stops beating Textile's bid?
import { formatUnits, parseAbi, parseUnits, type Address } from 'viem'
import { pub } from './wallet.js'
import { preview } from './textile.js'
import { TOKENS } from './config.js'

const QUOTER: Address = '0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8'
const quoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)',
])

for (const ngn of ['10000', '50000', '150000', '300000', '700000', '1500000']) {
  const amountIn = parseUnits(ngn, 6)
  const { result } = await pub.simulateContract({
    address: QUOTER, abi: quoterAbi, functionName: 'quoteExactInputSingle',
    args: [{ tokenIn: TOKENS.cNGN.address, tokenOut: TOKENS.USDT.address, amountIn, fee: 100, sqrtPriceLimitX96: 0n }],
  })
  const uni = Number(formatUnits(result[0], 6))
  const t = await preview({ sellToken: TOKENS.cNGN.address, buyToken: TOKENS.USDT.address, sellAmount: amountIn.toString() })
  const tex = t.status === 'preview' ? Number(formatUnits(BigInt(t.buyAmount), 6)) : NaN
  console.log(`sell ₦${ngn.padStart(8)}  Uniswap ${uni.toFixed(2)} USDT (₦${(Number(ngn) / uni).toFixed(1)})  Textile ${isNaN(tex) ? t.reason : tex.toFixed(2) + ' USDT'}  edge ${isNaN(tex) ? '-' : '$' + (uni - tex).toFixed(2)}`)
}
