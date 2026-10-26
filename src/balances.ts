// Read-only: every token in the wallet and what each venue would pay for it in USDT. Sends nothing.
// Run: npm run balances
import { existsSync, readFileSync } from 'node:fs'
import { formatUnits } from 'viem'
import { account, pub } from './wallet.js'
import { balanceOf } from './swap.js'
import { mentoDiscover } from './mento.js'
import { uniDiscover } from './uniswap.js'
import { ALL_VENUES } from './venues.js'
import { TOKENS } from './config.js'

console.log('Wallet', account.address)
console.log('CELO (gas)', formatUnits(await pub.getBalance({ address: account.address }), 18))
await mentoDiscover().catch(() => null) // also learns Mento-only tokens
await uniDiscover(Object.keys(TOKENS)).catch(() => 0)

let total = 0, unpriced = 0
for (const [k, t] of Object.entries(TOKENS)) {
  if (k === 'CELO') continue
  const bal = await balanceOf(t.address)
  if (bal === 0n) continue
  const amount = Number(formatUnits(bal, t.decimals))
  if (k === 'USDT') { console.log(`USDT  ${amount.toFixed(4)}  = $${amount.toFixed(2)}`); total += amount; continue }
  const quotes = await Promise.all(ALL_VENUES.map(async (v) => [v.name, await v.quote(k, 'USDT', bal).catch(() => null)] as const))
  const best = Math.max(0, ...quotes.map(([, q]) => (q ? Number(formatUnits(q, 6)) : 0)))
  if (best === 0) unpriced++
  total += best
  console.log(`${k.padEnd(5)} ${amount.toFixed(4)}  ` + quotes.map(([n, q]) => `${n}: ${q ? '$' + Number(formatUnits(q, 6)).toFixed(4) : 'no quote'}`).join('  '))
}
console.log(`\nTotal (best exit for each): $${total.toFixed(2)}${unpriced ? `  (+ ${unpriced} token(s) no venue will quote right now)` : ''}`)
for (const f of ['pending.json', 'state.json']) if (existsSync(f)) console.log(`\n${f}: ${readFileSync(f, 'utf8').trim()}`)
