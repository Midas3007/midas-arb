// Read-only: shows what the bot sees on Mento and why each currency can or cannot be traded there.
// Run: npm run mento
import { formatUnits } from 'viem'
import { mentoDiscover, mentoListing, mentoQuote, mentoRoute } from './mento.js'
import { CORRIDORS, CORRIDORS_FIXED, MENTO_BROKER, TOKENS } from './config.js'

console.log(`Mento Broker ${MENTO_BROKER}`)
let known = 0, added: string[] = []
try { ({ count: known, added } = await mentoDiscover()) } catch (e) {
  console.log(`Could not read the Broker: ${(e as Error).message.split('\n')[0]}`)
  process.exit(1)
}
console.log(`${mentoListing.length} exchanges listed, ${known} between tokens the bot knows:`)
if (added.length) console.log(`New currencies found on Mento: ${added.join(' ')}`)
if (!CORRIDORS_FIXED) for (const k of added) if (!CORRIDORS.includes(k)) CORRIDORS.push(k)
for (const ex of mentoListing) console.log(`  ${ex.assets.map((a) => (a.startsWith('0x') ? `unknown ${a}` : a)).join(' / ')}`)

console.log('\n$5 round trip USDT -> X -> USDT on Mento:')
for (const X of CORRIDORS) {
  const r = mentoRoute('USDT', X)
  if (!r) { console.log(`  ${X.padEnd(5)} no route`); continue }
  const path = ['USDT', ...r.map((s) => s[1])].join(' > ')
  const mid = await mentoQuote('USDT', X, 5_000_000n)
  if (!mid) { console.log(`  ${X.padEnd(5)} ${path}: quote failed (stale oracle, trading limit or paused)`); continue }
  const back = await mentoQuote(X, 'USDT', mid)
  console.log(`  ${X.padEnd(5)} ${path}: $5 -> ${Number(formatUnits(mid, TOKENS[X].decimals)).toFixed(4)} ${X} -> ${back ? '$' + formatUnits(back, 6) : 'sell quote failed'}`)
}
