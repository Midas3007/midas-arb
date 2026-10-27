# Midas Arb (Kiyoshi v2)

FX arbitrage on Celo, built on [Kiyoshi](https://github.com/MELcodes99/kiyoshi) by Mel Okoye, with the original
author's blessing. Kiyoshi compared **Uniswap v3** and **Textile FX** on three currencies. This version adds
**Mento** as a third venue, many more currencies, and a safer, faster trading loop.

## What changed from Kiyoshi

| Area | Kiyoshi | Midas Arb |
|---|---|---|
| Venues | Uniswap, Textile | Uniswap, Textile, **Mento** (any buy venue x any sell venue) |
| Currencies | wBRL, wARS, cNGN | + USDm, EURm, BRLm, KESm, XOFm, PHPm, COPm, GHSm, USDC, plus **every other currency Mento trades** (found on-chain automatically). Discovery keeps whatever at least two venues can trade |
| Uniswap routing | direct pool only | direct, or one hop through USDC / USDm / CELO |
| Trade size | 100%, 50%, 25% of max | 6 sizes spread from min to max, then refined around the best |
| Profit check | before gas | **after gas** (live gas price x CELO price) |
| Scan speed | sequential, every 60s | all routes quoted in parallel, every 20s; repeated quotes cached for 4s to stay under rate limits |
| Amount sold on leg 2 | the quote | what actually arrived (balance at the swap's block); fixes the `STF` reverts |
| Leg 2 failure | could abandon the loss guard | every failure keeps the leftover under the loss guard |
| Restarts | forgot what leftovers cost; sold at any price | leftovers saved to `pending.json`; guard survives restarts and Ctrl+C |
| Approvals | unlimited | capped at 4 trades' worth (`APPROVAL_MODE`) |
| Failed transactions | sent and paid for | simulated first; a revert costs nothing |
| Bad days | none | `MAX_DAILY_LOSS_USD` stops new trades for the day |
| Failing routes | retried every cycle | 5-minute cooldown per route |
| RPC | one | backups via `CELO_RPCS` |
| Alerts | none | optional Telegram |
| Reporting | `/status`, `/trades` | + `npm run stats` (trades and profit per hour, per route) |

Everything else is Kiyoshi: the Textile RFQ client with its reactor check and reservation waits, the loss guard
idea, equity snapshots, deposit/withdrawal tracking, the HTTP API, Convert, and the safe-shutdown logic.

## Run it on Android (Termux)

You need Termux (from F-Droid) with Node.js and git, as for Kiyoshi.

**1. Stop the old bot** (only one bot may use a wallet): in its Termux session press `CTRL` then `c`, wait for
`stopped cleanly`.

**2. Download this bot**
```
cd ~
git clone https://github.com/Midas3007/midas-arb
cd midas-arb
npm install
```

**3. Bring your settings**
```
cp .env.example .env
nano .env
```
Put your existing key after `AGENT_PRIVATE_KEY=` (the same one as in `~/kiyoshi/.env`; view it with
`cat ~/kiyoshi/.env`). Leave `LIVE=0` for now. Save: `CTRL`+`o`, Enter. Exit: `CTRL`+`x`.

**4. Check the connection** (read-only)
```
npm run check
```

**5. Dry run: watch it find routes and price them (sends nothing)**
```
npm run desk
```
The first cycle prints `discovery:` with how many routes it found and which venue trades which currency, then
the best routes with their profit after gas. Let it run a while; `would trade` lines are what it would have done.
Stop with `CTRL`+`c`.

**6. Go live**: set `LIVE=1` in `.env`, then
```
termux-wake-lock
npm run desk
```
Start with a small `MAX_TRADE_USD` and raise it once you have seen it trade cleanly.

**Updates later**: `cd ~/midas-arb && git pull && npm install`, then start it again.

**Stats**: `npm run stats`.

**Mento check** (read-only): `npm run mento` lists Mento's exchanges and tests a $5 round trip per currency.

If `git pull` says *Please commit your changes or stash them*, run `git stash` first, then `git pull` again.

## BSC and Polygon (multi-chain desk)

A separate bot with its **own wallet** that trades USDT round trips between two exchanges on each chain
(BSC: PancakeSwap + Uniswap; Polygon: Uniswap + SushiSwap; Base: Uniswap + PancakeSwap + SushiSwap, trading
against USDC). It never touches the Celo wallet. It focuses on local currencies, euro/franc/pound stablecoins and
gold; big tokens (BNB, ETH, BTC) are skipped unless `MULTI_MAJORS=1`.

1. `npm run new-wallet`, put the key in `.env` as `MULTI_PRIVATE_KEY=` (keep `MULTI_LIVE=0`).
2. Fund that wallet with USDT plus a little gas: **BNB** on BSC, **POL** on Polygon, **ETH** on Base (Base uses **USDC** instead of USDT).
3. Dry run: `npm run multi -- bsc` or `npm run multi -- polygon`, or several at once: `npm run multi -- bsc polygon base`.
4. Live: set `MULTI_LIVE=1`. Each chain keeps its own files in `data-bsc/` and `data-polygon/`.

The Celo desk (`npm run desk`) and this one can run at the same time in two Termux sessions.

## Reacting to trades

Both desks watch the pools they trade through (and Mento's Broker and price oracles on Celo). Every
`WATCH_MS` (default 1500 ms) they check new blocks; when a watched pool trades, the affected currencies are
rescanned at once instead of waiting for the next `INTERVAL_SEC` scan. Quick rescans stay silent unless they
find a trade; the full scan line shows how many happened. Textile has no on-chain price feed, so its quotes are
still checked on the full scan.

## Settings

All in `.env`; see `.env.example` for the full list with defaults. The ones you are most likely to change:

| Setting | Default | What it does |
|---|---|---|
| `LIVE` | `0` | `1` trades real money |
| `MAX_TRADE_USD` | `70` | largest trade (never more than 90% of your USDT) |
| `MIN_EDGE_USD` | `0.02` | smallest profit worth taking, after gas |
| `INTERVAL_SEC` | `20` | seconds between scans |
| `MAX_DAILY_LOSS_USD` | `5` | stop opening trades for the day after this realized loss |
| `VENUES` | `uniswap,textile,mento` | drop one to stop using it |
| `CORRIDORS` | all | limit to some currencies, e.g. `wBRL,BRLm` |

## Telegram alerts (optional)

1. In Telegram, message **@BotFather**, send `/newbot`, follow the steps, copy the token.
2. Message your new bot once, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and copy
   the `"chat":{"id": ...}` number.
3. Add `TELEGRAM_BOT_TOKEN=...` and `TELEGRAM_CHAT_ID=...` to `.env`.

You get a message on start, on every failed second leg, on leftover sales, and on new errors.

## How a trade works

1. **Flatten**: any leftover currency is sold if the best exit loses at most 0.5% of its cost, or after 30 minutes.
   No new trades while holding.
2. **Discover** (every 6 hours): find Uniswap pools, read Mento's exchanges from its Broker, and check which venues
   can quote each currency both ways for ~$5.
3. **Scan**: for every route (currency, buy venue, sell venue), search for the most profitable size and subtract
   gas.
4. **Trade** the best route if its profit after gas is at least `MIN_EDGE_USD`:
   - leg 1 buys the currency with a 0.3% slippage limit (Textile: a firm quote that must meet the same limit);
   - the leftover is recorded in `pending.json` before leg 2;
   - leg 2 sells exactly what arrived, and never for less than leg 1 cost (break-even floor);
   - if leg 2 fails for any reason, the route cools down for 5 minutes and step 1 takes over the leftover.

## Tests

```
npm test        # routes, size search, loss guard, kill switch, pending store (fake venues, no network)
npm run typecheck
```

## Limits

- Mento quotes revert while an oracle is stale or a trading limit is reached; such routes simply drop out until
  they work again. A Mento trade through USDm is two transactions; if the second fails, the USDm left over is
  sold by the loss guard like any leftover.
- Profit depends on gaps other traders open. Competing bots on the same routes take some of them.
- Not audited. Keep only trading capital in the agent wallet.
