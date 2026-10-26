// REAL MONEY. Usage: npm run trade -- USDT cNGN 1
import { formatUnits, parseUnits } from 'viem'
import { swap } from './swap.js'
import { TOKENS, type TokenKey } from './config.js'

const [sell, buy, amount] = process.argv.slice(2) as [TokenKey, TokenKey, string]
if (!TOKENS[sell] || !TOKENS[buy] || !amount) {
  console.log('Usage: npm run trade -- <SELL> <BUY> <amount>   e.g. USDT cNGN 1')
  process.exit(1)
}
const r = await swap(sell, buy, parseUnits(amount, TOKENS[sell].decimals))
if (r.status !== 'filled') console.log(r)
else console.log(`Filled ${r.rfqId}\n  paid     ${formatUnits(r.paid, 6)} ${sell}\n  received ${formatUnits(r.received, 6)} ${buy}\n  tx       https://celoscan.io/tx/${r.txHash}`)
