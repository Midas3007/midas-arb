# Peg Hunter: plan and decisions

Midas-arb becomes **Peg Hunter**: it finds pools where currency-pegged stablecoins trade away from their real
exchange rate on cheap-gas EVM chains and trades them back, with both legs on one chain.

## Decisions (agreed 31 Oct 2026)

| # | Topic | Decision |
|---|---|---|
| 1 | Name | Midas-arb: Peg Hunter |
| 2 | Old code | Kiyoshi v2 FX desk removed; previous version is commit `66ac813` on `main` (tag `kiyoshi-v2-final` locally). Kept and reused: venue quoting, loss guard, pre-send simulation, pending store, Telegram, split, gas top-up, pool watcher. **Changed while building:** Textile was kept as a Celo venue, because cNGN, wBRL and wARS have a single Uniswap pool each on Celo and Textile is the only other place they trade at real FX rates (very likely where the $5 → $110 day came from). |
| 3 | Celo | In. Cash is USDT (Textile trades against it); Mento is reached through Uniswap's deep USDT/USDm pool. |
| 4 | Cheap gas | A swap must cost under $0.01 (`MAX_SWAP_GAS_USD`). Chains: Celo, Base, BSC, Polygon, Arbitrum, Optimism, Avalanche, Gnosis, Sei. Ethereum mainnet out. |
| 5 | Chains earn their place | Watch 3 days → live if ≥5 gaps worth ≥$0.10 seen → paused after 7 days without profit → watch again after 7 days. |
| 6 | Splitting cash | By earnings per dollar over 7 days; every live chain ≥5%, none >40%. |
| 7 | Holding exotic coins | Two separate swaps with the loss guard for now. One-transaction contract later, only on chains that make money. |
| 8 | Trade size | 20% of the chain's cash (realized balance), $2 floor for small wallets, $100 cap, exit pool may move ≤1%. |
| 9 | Smallest gap | 0.3% after gas and fees, and ≥$0.01. |
| 10 | Coins | Hand-checked official addresses per chain, verified on-chain at startup; unknown tokens never traded. |
| 11 | Profit | From the ledger only (trades after gas, minus fees). Per-chain high-water marks. Deposits never count. |
| 12 | Sweep trigger | $20 of new profit → 50% swept. |
| 13 | Sweep destination | USDT on BSC (default), to `SWEEP_TO`. |
| 14 | Sweep cost | Bridges over 2% skipped; a chain's part under $3 waits. |
| 15 | Hosting | Termux first; profitable chains move to Render later (`HUNTER_CHAINS`). |
| 16 | Telegram | `/status /chains /chain /gaps /withdraw /pause /resume`; alerts on trades ≥$1. |
| 17 | Wallet | One new key (`HUNTER_PRIVATE_KEY`) for all chains, refused if it equals the Kiyoshi or fund key. |
| + | Depeg trap | All of a coin's pools >3% off the same way = frozen; on 2+ chains = currency frozen. |
| + | Bad oracles | Two fresh sources must agree within 2%; weekend-aware staleness. |
| + | Sandwiches | 0.3% slippage, simulate before sending. |
| + | Gas from profit | Gas is paid by each chain's own cash and counted in each trade's net before any sweep. |

## Found while building

- **Pyth's price API now needs an API key** (HTTP 401), so fair prices come from Mento's oracles plus two free
  daily FX APIs. Every currency in the coin list has at least two agreeing sources (checked 31 Oct).
- **Mento's oracles stop at weekends** (13 h old on a Saturday), so staleness limits are wider then, and Mento
  routes close (their swaps would revert). Textile and the pools keep trading.
- **LI.FI cannot swap CELO on Celo**; deposits and gas top-ups there go straight through Uniswap.
- **Textile on 31 Oct:** 5 USDT bought 6,860 cNGN, 1,372 NGN/$ vs a fair 1,346: cNGN 1.9% cheap there. This is
  the kind of gap Peg Hunter is built for.

## Next

1. Watch all chains for 3+ days on Termux; read `npm run report`.
2. Fund the chains that earned their place; `HUNTER_LIVE=1` with a `SWEEP_TO` address.
3. Move the profitable chains to Render (`HUNTER_CHAINS=...`), with private RPC URLs.
4. One-transaction trade contract on those chains (no leftovers possible, one gas payment).
5. More venues where pegged coins have deep liquidity off Uniswap-v3: Curve (EURe on Gnosis), Velodrome/Aerodrome
   (Optimism/Base), LFJ (Avalanche).
