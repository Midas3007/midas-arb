// npm run check  (read-only, sends nothing): for every chain, is it reachable, what does a swap cost, which
// exchanges and stablecoins were found, and does each currency have a fair price.
import 'dotenv/config'
import { erc20Abi, formatUnits } from 'viem'
import { CHAINS, chainKeys, envDexes } from './chains.js'
import { clientsFor } from './clients.js'
import { FairPrices } from './fair.js'
import { lifiPrice, NATIVE } from './lifi.js'
import { aaveInfo, SAVINGS_MIN_APY } from './savings.js'

const maxGas = Number(process.env.MAX_SWAP_GAS_USD ?? '0.01')
const wanted = process.argv.slice(2).map((s) => s.toLowerCase())
const keys = wanted.length ? wanted : chainKeys()
const fair = new FairPrices()
await fair.refresh()
const ccys = new Set<string>()

for (const k of keys) {
  const p = CHAINS[k]
  if (!p) { console.log(`${k}: unknown chain`); continue }
  const { pub, account } = clientsFor(p)
  try {
    const block = await pub.getBlockNumber()
    const gasPrice = await pub.getGasPrice()
    const nativeUsd = p.native === 'USDT' ? 1 : await lifiPrice(p.chain.id, p.lifiNative ?? NATIVE)
    const swapUsd = Number(formatUnits(gasPrice * 180_000n, 18)) * nativeUsd
    const dexes = await Promise.all([...p.dexes, ...envDexes(k)].map(async (d) => {
      const codes = await Promise.all([d.factory, d.quoter, d.router].map((a) => pub.getCode({ address: a }).catch(() => undefined)))
      return `${d.name} ${codes.every((c) => c && c !== '0x') ? 'ok' : 'MISSING'}`
    }))
    for (const sv of p.solidly ?? []) dexes.push(`${sv.name} ${(await pub.getCode({ address: sv.router }).catch(() => undefined))?.length ? 'ok' : 'MISSING'}`)
    if (p.curve) dexes.push(`curve ${await fetch(`https://api.curve.finance/v1/getPools/all/${p.curve}`, { signal: AbortSignal.timeout(20_000) }).then((r) => (r.ok ? 'ok' : 'API down')).catch(() => 'API down')}`)
    if (p.mento) { const c = await pub.getCode({ address: p.mento.broker }).catch(() => undefined); dexes.push(`mento ${c && c !== '0x' ? 'ok' : 'MISSING'}`) }
    if (p.textile) { const ok = await fetch(`${p.textile.api}/tickers?ticker_id=USDT_NGN`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.ok).catch(() => false); dexes.push(`textile ${ok ? 'ok' : 'UNREACHABLE'}`) }
    const pegs = await Promise.all(Object.entries(p.pegs).map(async ([sym, g]) => {
      const s = await pub.readContract({ address: g.address, abi: erc20Abi, functionName: 'symbol' }).catch(() => null)
      const ok = s !== null && g.expect.includes(String(s).toUpperCase().replace(/[^A-Z0-9]/g, ''))
      if (ok) ccys.add(g.ccy)
      return ok ? `${sym}` : `${sym}(✗ ${s ?? 'no token'})`
    }))
    const sav = await aaveInfo(clientsFor(p)).catch(() => null)
    if (sav) dexes.push(`aave ${sav.apyPct.toFixed(2)}% on ${p.cashName}${sav.apyPct < SAVINGS_MIN_APY ? ' (under SAVINGS_MIN_APY: not used)' : ''}`)
    const cash = await pub.readContract({ address: p.tokens.USDT.address, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }).catch(() => 0n)
    console.log(`\n${k}  block ${block}  swap ≈ $${swapUsd.toFixed(5)} ${swapUsd <= maxGas ? '(cheap enough)' : `(OVER $${maxGas}: stays watch-only)`}`)
    console.log(`  exchanges: ${dexes.join(', ')}`)
    console.log(`  stablecoins: ${pegs.join(' ')}`)
    console.log(`  wallet ${account.address}: ${p.cashName} ${formatUnits(cash, p.tokens.USDT.decimals)}`)
  } catch (e: any) {
    console.log(`\n${k}  UNREACHABLE: ${String(e?.shortMessage ?? e?.message ?? e).split('\n')[0]} (set ${k.toUpperCase()}_RPCS)`)
  }
}

console.log('\nfair prices (units per dollar):')
for (const c of [...ccys].filter((c) => c !== 'USD').sort()) {
  const f = fair.get(c)
  console.log(`  ${c}  ${f.usdPer ? (1 / f.usdPer).toPrecision(6) : '-'}  ${f.status}  ${f.sources.map((s) => s.source).join('+')}${f.note ? `  ${f.note}` : ''}`)
}
for (const e of fair.errors) console.log(`  source problem: ${e}`)
process.exit(0)
