// Read-only scan for a tradable FX gap on Celo using only USDT. Sends NO transactions.
import { formatUnits, parseAbi, parseUnits, type Address } from 'viem'
import { pub } from './wallet.js'
import { preview } from './textile.js'

const T: Record<string, { a: Address; d: number }> = {
  USDT: { a: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e', d: 6 },
  USDm: { a: '0x765DE816845861e75A25fCA122bb6898B8B1282a', d: 18 },
  NGNm: { a: '0xE2702Bd97ee33c88c8f6f92DA3B733608aa76F71', d: 18 },
  cNGN: { a: '0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f', d: 6 },
  wBRL: { a: '0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0', d: 18 },
  wARS: { a: '0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D', d: 18 },
}
const sym = (a: string) => Object.keys(T).find((k) => T[k].a.toLowerCase() === a.toLowerCase()) ?? a.slice(0, 8)

// ---- Uniswap v3 (Celo)
const QUOTER: Address = '0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8'
const quoterAbi = parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)'])
async function uni(tin: string, tout: string, amt: bigint) {
  let best: { out: bigint; fee: number } | null = null
  for (const fee of [100, 500, 3000, 10000]) {
    try {
      const { result } = await pub.simulateContract({ address: QUOTER, abi: quoterAbi, functionName: 'quoteExactInputSingle',
        args: [{ tokenIn: T[tin].a, tokenOut: T[tout].a, amountIn: amt, fee, sqrtPriceLimitX96: 0n }] })
      if (!best || result[0] > best.out) best = { out: result[0], fee }
    } catch {}
  }
  return best
}

// ---- Mento (Celo)
const BROKER: Address = '0x777A8255cA72412f0d706dc03C9D1987306B4CaD'
const BIPOOL: Address = '0x22d9db95E6Ae61c104A7B6F6C78D7993B94ec901'
const bipoolAbi = parseAbi(['function getExchanges() view returns ((bytes32 exchangeId, address[] assets)[])'])
const brokerAbi = parseAbi(['function getAmountOut(address,bytes32,address,address,uint256) view returns (uint256)'])
let exchanges: { exchangeId: `0x${string}`; assets: readonly Address[] }[] = []
try { exchanges = [...await pub.readContract({ address: BIPOOL, abi: bipoolAbi, functionName: 'getExchanges' })] } catch (e: any) { console.log('Mento getExchanges failed:', e.shortMessage ?? e.message) }
async function mento(tin: string, tout: string, amt: bigint) {
  const ex = exchanges.find((x) => x.assets.map((a) => a.toLowerCase()).includes(T[tin].a.toLowerCase()) && x.assets.map((a) => a.toLowerCase()).includes(T[tout].a.toLowerCase()))
  if (!ex) return null
  try { return await pub.readContract({ address: BROKER, abi: brokerAbi, functionName: 'getAmountOut', args: [BIPOOL, ex.exchangeId, T[tin].a, T[tout].a, amt] }) } catch { return null }
}
async function textile(tin: string, tout: string, amt: bigint) {
  try {
    const p = await preview({ sellToken: T[tin].a, buyToken: T[tout].a, sellAmount: amt.toString() })
    return p.status === 'preview' ? BigInt(p.buyAmount) : null
  } catch { return null }
}
const f = (k: string, v: bigint) => `${Number(formatUnits(v, T[k].d)).toFixed(4)} ${k}`

console.log('== Mento pairs touching NGNm / USDm ==')
for (const x of exchanges) {
  const s = x.assets.map(sym)
  if (s.includes('NGNm') || (s.includes('USDm') && (s.includes('USDT') || s.includes('USDC') || s.includes('USDT')))) console.log('  ', s.join(' / '))
}

const START = parseUnits('50', 6)
console.log('\n== Route: 50 USDT -> USDm -> NGNm -> cNGN -> USDT ==')
const hop1 = await mento('USDT', 'USDm', START)
console.log('  USDT->USDm (Mento):', hop1 === null ? 'no route' : f('USDm', hop1))
const hop2 = hop1 !== null ? await mento('USDm', 'NGNm', hop1) : null
console.log('  USDm->NGNm (Mento):', hop2 === null ? 'no route' : f('NGNm', hop2))
const hop3 = hop2 !== null ? await uni('NGNm', 'cNGN', hop2) : null
console.log('  NGNm->cNGN (Uniswap):', hop3 === null ? 'no pool' : `${f('cNGN', hop3.out)} (fee ${hop3.fee})`)
if (hop3) {
  const backUni = await uni('cNGN', 'USDT', hop3.out)
  const backTex = await textile('cNGN', 'USDT', hop3.out)
  if (backUni) console.log(`  cNGN->USDT (Uniswap): ${f('USDT', backUni.out)}  P&L ${(Number(formatUnits(backUni.out, 6)) - 50).toFixed(4)}`)
  if (backTex) console.log(`  cNGN->USDT (Textile): ${f('USDT', backTex)}  P&L ${(Number(formatUnits(backTex, 6)) - 50).toFixed(4)}`)
}
if (hop2 !== null) {
  const ngnmDirect = await uni('NGNm', 'USDT', hop2)
  console.log('  (NGNm->USDT on Uniswap, for reference):', ngnmDirect ? f('USDT', ngnmDirect.out) : 'no pool')
}

for (const X of ['wBRL', 'wARS']) {
  console.log(`\n== ${X}: Uniswap vs Textile, 50 USDT ==`)
  const a1 = await uni('USDT', X, START)
  const a2 = a1 ? await textile(X, 'USDT', a1.out) : null
  console.log(`  buy on Uniswap, sell on Textile: ${a1 ? f(X, a1.out) : 'no Uniswap pool'} -> ${a2 ? f('USDT', a2) + `  P&L ${(Number(formatUnits(a2, 6)) - 50).toFixed(4)}` : 'no Textile quote'}`)
  const b1 = await textile('USDT', X, START)
  const b2 = b1 ? await uni(X, 'USDT', b1) : null
  console.log(`  buy on Textile, sell on Uniswap: ${b1 ? f(X, b1) : 'no Textile quote'} -> ${b2 ? f('USDT', b2.out) + `  P&L ${(Number(formatUnits(b2.out, 6)) - 50).toFixed(4)}` : 'no Uniswap pool'}`)
  const m1 = await mento('USDm', X, parseUnits('50', 18))
  if (m1 !== null) console.log(`  (Mento has a USDm/${X} pair: 50 USDm -> ${f(X, m1)})`)
}
