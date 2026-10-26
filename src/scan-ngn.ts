// Read-only: test each hop of USDT -> USDm -> NGNm -> cNGN independently. Sends NO transactions.
import { formatUnits, parseAbi, parseUnits, type Address } from 'viem'
import { pub } from './wallet.js'
import { preview } from './textile.js'

const T: Record<string, { a: Address; d: number }> = {
  USDT: { a: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e', d: 6 },
  USDC: { a: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', d: 6 },
  USDm: { a: '0x765DE816845861e75A25fCA122bb6898B8B1282a', d: 18 },
  NGNm: { a: '0xE2702Bd97ee33c88c8f6f92DA3B733608aa76F71', d: 18 },
  cNGN: { a: '0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f', d: 6 },
}
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
const BROKER: Address = '0x777A8255cA72412f0d706dc03C9D1987306B4CaD'
const BIPOOL: Address = '0x22d9db95E6Ae61c104A7B6F6C78D7993B94ec901'
const ex = [...await pub.readContract({ address: BIPOOL, abi: parseAbi(['function getExchanges() view returns ((bytes32 exchangeId, address[] assets)[])']), functionName: 'getExchanges' })]
async function mento(tin: string, tout: string, amt: bigint) {
  const e = ex.find((x) => { const s = x.assets.map((a) => a.toLowerCase()); return s.includes(T[tin].a.toLowerCase()) && s.includes(T[tout].a.toLowerCase()) })
  if (!e) return 'no pair'
  try { return await pub.readContract({ address: BROKER, abi: parseAbi(['function getAmountOut(address,bytes32,address,address,uint256) view returns (uint256)']), functionName: 'getAmountOut', args: [BIPOOL, e.exchangeId, T[tin].a, T[tout].a, amt] }) }
  catch (err: any) { return 'error: ' + (err.shortMessage ?? err.message) }
}
const show = (k: string, v: any) => typeof v === 'bigint' ? `${Number(formatUnits(v, T[k].d)).toFixed(4)} ${k}` : v === null ? 'no pool' : typeof v === 'object' ? `${Number(formatUnits(v.out, T[k].d)).toFixed(4)} ${k} (fee ${v.fee})` : v

console.log('Hop tests (each on its own):')
console.log('  50 USDT -> USDm  Uniswap :', show('USDm', await uni('USDT', 'USDm', parseUnits('50', 6))))
console.log('  50 USDC -> USDm  Mento   :', show('USDm', await mento('USDC', 'USDm', parseUnits('50', 6))))
console.log('  50 USDm -> NGNm  Mento   :', show('NGNm', await mento('USDm', 'NGNm', parseUnits('50', 18))))
console.log('  70000 NGNm -> cNGN Uniswap:', show('cNGN', await uni('NGNm', 'cNGN', parseUnits('70000', 18))))
console.log('  70000 cNGN -> NGNm Uniswap:', show('NGNm', await uni('cNGN', 'NGNm', parseUnits('70000', 6))))
console.log('  70000 NGNm -> USDT Uniswap:', show('USDT', await uni('NGNm', 'USDT', parseUnits('70000', 18))))
console.log('  70000 NGNm -> USDm Uniswap:', show('USDm', await uni('NGNm', 'USDm', parseUnits('70000', 18))))

// Full loop if the hops exist
const a = await uni('USDT', 'USDm', parseUnits('50', 6))
if (a) {
  const b = await mento('USDm', 'NGNm', a.out)
  if (typeof b === 'bigint') {
    console.log(`\nLoop: 50 USDT -> ${show('USDm', a.out)} -> ${show('NGNm', b)}`)
    const c = await uni('NGNm', 'cNGN', b)
    if (c) {
      const d = await uni('cNGN', 'USDT', c.out)
      const t = await preview({ sellToken: T.cNGN.a, buyToken: T.USDT.a, sellAmount: c.out.toString() })
      console.log(`  -> ${show('cNGN', c)}`)
      if (d) console.log(`  -> Uniswap ${show('USDT', d.out)}   P&L ${(Number(formatUnits(d.out, 6)) - 50).toFixed(4)}`)
      if (t.status === 'preview') console.log(`  -> Textile ${(Number(formatUnits(BigInt(t.buyAmount), 6))).toFixed(4)} USDT   P&L ${(Number(formatUnits(BigInt(t.buyAmount), 6)) - 50).toFixed(4)}`)
    } else console.log('  NGNm -> cNGN: no Uniswap pool, loop stops here')
  }
}
