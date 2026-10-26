// Read-only: find which sizes Textile makers will quote on Celo. Sends NO transactions.
import { formatUnits } from 'viem'
import { preview } from './textile.js'
import { TOKENS } from './config.js'

const legs = [
  { label: 'USDT -> cNGN', sell: TOKENS.USDT, buy: TOKENS.cNGN, sizes: ['1', '5', '10', '50', '200'] },
  { label: 'cNGN -> USDT', sell: TOKENS.cNGN, buy: TOKENS.USDT, sizes: ['1500', '7000', '14000', '70000'] },
]

for (const leg of legs) {
  for (const s of leg.sizes) {
    const sellAmount = (BigInt(Math.round(Number(s) * 1e6))).toString()
    try {
      const p = await preview({ sellToken: leg.sell.address, buyToken: leg.buy.address, sellAmount })
      console.log(`${leg.label} ${s.padStart(6)}:`, p.status === 'preview'
        ? `${formatUnits(BigInt(p.buyAmount), 6)}  (fee ${formatUnits(BigInt(p.feeAmount), 6)})`
        : `no_quote ${p.reason}${p.availableSellAmount ? ` depth ${formatUnits(BigInt(p.availableSellAmount), 6)}` : ''}${p.retryAfterMs ? ` retry ${p.retryAfterMs}ms` : ''}`)
    } catch (e: any) {
      console.log(`${leg.label} ${s.padStart(6)}: error ${e.message}`)
    }
  }
}
