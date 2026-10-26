// Read-only: shows what the bot sees on Mento and why each currency can or cannot be traded there.
// Run: npm run mento
import { formatUnits } from 'viem'
import { mentoDiscover, mentoLimitReason, mentoListing, mentoRoute, mentoRouteClosed } from './mento.js'
import { uniDiscover } from './uniswap.js'
import { ALL_VENUES } from './venues.js'
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

await uniDiscover(CORRIDORS) // the Mento venue enters and leaves USDm on Uniswap
const mento = ALL_VENUES.find((v) => v.name === 'mento')!
console.log('\n$5 round trip USDT -> X -> USDT on Mento (USDT <-> USDm on Uniswap when Mento has no USDT path):')
for (const X of CORRIDORS) {
  if (X === 'USDm') continue
  const r = mentoRoute('USDT', X) ?? mentoRoute('USDm', X)
  if (!r) { console.log(`  ${X.padEnd(5)} no route`); continue }
  const path = [mentoRoute('USDT', X) ? 'USDT' : 'USDT >(uniswap)> USDm', ...r.map((s) => s[1])].join(' > ')
  const closed = await mentoRouteClosed(mentoRoute('USDT', X) ? 'USDT' : 'USDm', X)
  if (closed) { console.log(`  ${X.padEnd(5)} ${path}: CLOSED (${closed})`); continue }
  const hub = mentoRoute('USDT', X) ? 'USDT' : 'USDm'
  const probe = hub === 'USDT' ? 5_000_000n : 5n * 10n ** 18n
  const buyLimit = await mentoLimitReason(hub, X, probe).catch(() => null)
  if (buyLimit) console.log(`  ${X.padEnd(5)} buying on Mento blocked: ${buyLimit}`)
  const mid = await mento.quote('USDT', X, 5_000_000n)
  if (!mid) { console.log(`  ${X.padEnd(5)} ${path}: quote failed (stale oracle, trading limit or paused)`); continue }
  const back = await mento.quote(X, 'USDT', mid)
  console.log(`  ${X.padEnd(5)} ${path}: $5 -> ${Number(formatUnits(mid, TOKENS[X].decimals)).toFixed(4)} ${X} -> ${back ? '$' + formatUnits(back, 6) : 'sell quote failed'}`)
}
