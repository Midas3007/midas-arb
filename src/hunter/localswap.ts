// Same-chain swap directly on the chain's first Uniswap-v3-style exchange, for when LI.FI has no route (CELO on
// Celo: its gas token is also an ERC-20, so it can be swapped like any token). Best of the direct pools and the
// paths through each hub, quoted on-chain; the swap is simulated before it is sent and must deliver 99% of the
// quote.
import { encodeFunctionData, encodePacked, erc20Abi, parseAbi, type Address, type Hex } from 'viem'
import type { ChainClients } from './clients.js'

const quoterAbi = parseAbi(['function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[], uint32[], uint256)'])
const router02Abi = parseAbi(['function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256)'])
const routerV1Abi = parseAbi(['function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256)'])

export async function localSwap(c: ChainClients, tokenIn: Address, tokenOut: Address, amount: bigint, go: boolean): Promise<{ out: bigint; hash?: Hex }> {
  const { p, pub, wallet, account } = c
  const d = p.dexes[0]
  const hubs = p.hubs.map((h) => p.tokens[h]?.address).filter((a): a is Address => !!a && a !== tokenIn && a !== tokenOut)
  const paths: Hex[] = []
  for (const f of d.fees) paths.push(encodePacked(['address', 'uint24', 'address'], [tokenIn, f, tokenOut]))
  for (const h of hubs) for (const f1 of d.fees) for (const f2 of d.fees)
    paths.push(encodePacked(['address', 'uint24', 'address', 'uint24', 'address'], [tokenIn, f1, h, f2, tokenOut]))
  let best: { path: Hex; out: bigint } | null = null
  await Promise.all(paths.map(async (path) => {
    try {
      const { result } = await pub.simulateContract({ address: d.quoter, abi: quoterAbi, functionName: 'quoteExactInput', args: [path, amount] })
      if (!best || result[0] > best.out) best = { path, out: result[0] }
    } catch { /* no pool on this path */ }
  }))
  if (!best) throw new Error(`no ${d.name} route on ${p.key}`)
  const b = best as { path: Hex; out: bigint }
  if (!go) return { out: b.out }
  const allowance = await pub.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'allowance', args: [account.address, d.router] })
  if (allowance < amount) {
    const send = async (amt: bigint) => pub.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ account, chain: p.chain, to: tokenIn, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [d.router, amt] }) }) })
    if (allowance > 0n) await send(0n)
    await send(amount)
  }
  const min = (b.out * 99n) / 100n
  const data = d.routerStyle === '02'
    ? encodeFunctionData({ abi: router02Abi, functionName: 'exactInput', args: [{ path: b.path, recipient: account.address, amountIn: amount, amountOutMinimum: min }] })
    : encodeFunctionData({ abi: routerV1Abi, functionName: 'exactInput', args: [{ path: b.path, recipient: account.address, deadline: BigInt(Math.floor(Date.now() / 1000) + 300), amountIn: amount, amountOutMinimum: min }] })
  await pub.call({ account, to: d.router, data }) // simulate first
  const hash = await wallet.sendTransaction({ account, chain: p.chain, to: d.router, data })
  const r = await pub.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error(`swap reverted: ${hash}`)
  return { out: b.out, hash }
}
