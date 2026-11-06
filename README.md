<p align="center"><img src="docs/brand/peg-hunter-logo.png" alt="Peg Hunter" width="600"></p>

# Midas-arb: Peg Hunter

**A stablecoin pegged to a real currency has a known fair price: the real exchange rate.** A cNGN is worth about
1/1,346 of a dollar, a EURC about $1.12, whatever a pool says. This repo holds two things built on that idea:

| | What it is | Runs |
|---|---|---|
| **The FX desk** (`npm start`) | A trading bot in the style of Kiyoshi: it buys a currency coin where it is cheap and sells it where it is dear, on the same chain, between DEXes and **Textile**'s RFQ desk | on your phone (Termux), later on Render |
| **Midas FX Quotes** (`npm run fx-api`) | A public API that tells agents what a currency trade will actually execute at, per venue and at their size. Agents pay $0.01 a call with x402 | live at **https://midas-fx-api.onrender.com** |

Both use the same exchange code, the same honest quotes and the same fair prices.

> Peg Hunter replaced the Kiyoshi v2 FX desk that used to live in this repo. That version is commit `66ac813` on
> `main` (tag `kiyoshi-v2-final`).

---

## Midas FX Quotes (the API)

```
GET /fx                          free: currencies covered, their official rate, where each trades
GET /fx/NGN?size=50000           $0.01: per venue, the rate for buying and for selling $50,000 worth, slippage
                                 against a $10 trade there, spread against the official rate, best venue per side
GET /fx/NGN/history?hours=24     $0.01: the recorded series ($100, $1,000, $10,000 every 5 minutes)
```

- **Coverage:** 19 currencies (NGN, BRL, ARS, EUR, KES, GHS, PHP, ZAR, COP, MXN, IDR, SGD, CHF, GBP, CAD, AUD, JPY,
  TRY, XOF) on Celo, Base, BSC and Polygon. Venues: Uniswap v3 and v4, Aerodrome, PancakeSwap, Sushi, Curve, Mento
  and Textile's RFQ desk.
- **Honest quotes:** every quote is made with a real gas price, so pools that show bots fake prices (see *Trap
  pools* below) show their real one. Pools priced over 20% from the official rate are left out and listed under
  `excluded`.
- **Official rate:** Mento's on-chain oracles plus two daily FX feeds. For NGN and ARS, on-chain prices follow the
  market rate, so their spread against it is large and steady; the response says so.
- **Limits:** 60 requests a minute per IP, sizes $1 to $1,000,000, answers cached for 10 seconds.

It publishes what public contracts and Textile's makers would execute at, computed from on-chain quotes, not
bureau-de-change or parallel-market quotes. (Not legal advice; if you ever serve fiat quotes, ask a Nigerian lawyer.)

### Payments (x402)

- **Per call:** `X402_PRICE_USD=0.01`. The 402 answer speaks both protocol versions: v2 (`PAYMENT-REQUIRED`,
  `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`, network `eip155:8453`) and v1 (`X-PAYMENT`, the challenge in the body).
- **Settlement:** through **PayAI's facilitator** by default (`X402_FACILITATOR_URL`; it pays the gas and needs no
  account), or by the server itself with `X402_FACILITATOR_URL=self` (the bot wallet pays ~$0.002 gas a call, and
  the endpoint is not catalogued).
- **Where the money goes:** `X402_PAY_TO`, your own Base address. Required when the server has no wallet key, so
  payments never go to a throwaway address. The API needs no private key and should not be given one.
- **API keys:** `FX_API_KEYS=key1,key2` (sent as `x-api-key`) for teams on a monthly plan; they skip payment.
- **Pay one call yourself:** `npm run fx-pay -- https://midas-fx-api.onrender.com/fx/NGN?size=1000` pays $0.01 from
  the bot wallet (USDC on Base) and prints the receipt and the answer.

### How agents find it

| What | Where | Read by |
|---|---|---|
| 402 challenge with the **Bazaar** extension (inputs, outputs, `routeTemplate` `/fx/:ccy`, service name, tags) | every paid URL | x402 clients, PayAI's Bazaar, x402scan |
| OpenAPI with `x-payment-info` (free routes marked `security: []`) | `/openapi.json` | x402scan, API tools |
| List of paid URLs | `/.well-known/x402` | x402scan |
| Plain-language guide | `/llms.txt`, `/` | language-model agents, people |

Listed in **PayAI's Bazaar** since the first paid call (6 Nov 2026). Register on **x402scan** at
https://www.x402scan.com/resources/register and on **x402-list.com/submit**. Coinbase's Bazaar and Agentic.Market list
endpoints whose payments settle through Coinbase's facilitator, which this server does not use yet.

### Deploying it

`render.yaml` is a Render Blueprint: an always-on Starter web service (about $7 a month, billed by the second it
runs) with a 1 GB disk for the history (`DATA_DIR=/var/data`). Set `X402_PAY_TO`, and optionally `PUBLIC_URL` (the
address the discovery documents give; by default the request's own host) and `API_CONTACT_EMAIL` (shown publicly in
`/openapi.json`; x402scan uses it to verify ownership). `FX_API_CHAINS` picks the chains (default Celo, Base, BSC,
Polygon); `FX_RECORD_MIN` the history interval (5 minutes; 15 cuts the bot's outbound traffic to a third).
`FX_API_PORT=8080` serves the same API from inside the trading bot instead.

Break-even is about 25 paid calls a day. Agent traffic is still small; a team on a monthly key is worth more than
months of stray calls, and the recorded history is the part nobody else has.

---

## The FX desk (the trading bot)

### What it trades

- **Currency coins**, like Kiyoshi: cNGN, wBRL, wARS, EURC, XSGD, VGBP, Mento's KESm, NGNm, PHPm... Dollar coins
  (USAT, USDC) only against Textile, as Kiyoshi does (USAT Textile to Uniswap paid about $0.03 a trade on 1 Nov 2026);
  other dollar-coin routes are off, since that is where trap pools sit. `TEXTILE_USD=0` drops dollar coins entirely,
  `FX_ONLY=0` allows them everywhere.
- **Chains:** **Celo and Base** by default. A one-hour survey of the four cheap chains Textile serves found the
  gaps and near-gaps there ([docs/FX_SURVEY.md](docs/FX_SURVEY.md)): wARS and cNGN between Textile and Uniswap on
  Celo, EURC between Uniswap and Aerodrome on Base, and (since the v4 fix) cNGN between Textile and Uniswap v4 on Base.
  `HUNTER_CHAINS=celo,base,bsc,polygon` adds BSC and Polygon; `all` runs every chain the code knows (Arbitrum,
  Optimism, Avalanche, Gnosis, Sei, and Robinhood Chain's stock tokens).
- **Venues:** Uniswap v3 and v4 (hookless pools at the standard tiers plus known extra ones, such as Base's 0.15%
  cNGN/USDC pool; `<CHAIN>_V4_TIERS=fee:tickSpacing`), Aerodrome (Base), PancakeSwap, Sushi, Curve (pools from
  Curve's API, cached on disk), Mento (Celo) and **Textile** (Celo, Base, BSC). Textile quotes filled from a maker's
  vault (Celo, BSC) are accepted; any other settlement contract is refused.
- **Coins are verified:** a hand-checked address list per chain (`src/hunter/chains.ts`, list and rejects in
  [docs/FX_COINS.md](docs/FX_COINS.md)), each address checked on-chain at start (its symbol must match), so copycat
  tokens are never traded.
- **Fair price:** Mento's oracles plus open.er-api.com and the fawazahmed0 currency API; a currency trades only when
  two fresh sources agree within 2%. FX markets close at weekends, so older prices are accepted then.

```
 fair price (Mento oracles + 2 daily feeds, must agree)
        │
 every pool + Textile, per coin ──► gap after gas and fees? ──► guards ──► buy cheap, sell dear, same chain
        │                                                         │
 new pools checked within 60 s          depeg · stuck pool · suspicious price · exit pool too thin · trap pool
```

**Kiyoshi's Textile rules:** a coin is sold to Textile only if its firm quote still covers the cost (otherwise the
loss guard sells it later, within 0.5%), and a Textile-first trade is skipped while Textile still holds the last
trade's money.

### Traps it avoids

| Trap | What it looks like | What it does |
|---|---|---|
| Trap pool (honeypot) | a steady gap; quotes and simulations pass; every real sale reverts | every quote and simulation carries a real gas price, so the pool shows its real price |
| An exchange that keeps failing | the same revert every scan | not used for that coin for 6 hours after an on-chain revert (30 minutes after a refusal); leftovers are sold elsewhere |
| A coin really lost its peg | every pool of it is "cheap" | all of a coin's pools over 3% off the same way: frozen on that chain; on 2+ chains, the whole currency. Alert on Telegram |
| A price feed stopped | a fair pool looks mispriced | needs 2 agreeing fresh sources |
| A pool nobody can trade | "off by 5%" for days | a pool off its peg for over 24 h is skipped |
| Fake token or broken pool | a quote 30% from fair | anything over 20% from fair is skipped |
| Textile's firm quote below its preview | stuck with the coin | selling to Textile is counted lower by how far its firm quotes really fell short, learned per coin |
| Thin exit pool | the sell leg eats the profit | sizes that move the exit pool over 1% are not considered |
| Sandwich bots | the swap fills worse than quoted | 0.3% slippage limit, every transaction simulated first |
| Half-finished trade | coin left over after leg 1 | leg 2 never sells below leg 1's cost; leftovers sold by the loss guard (saved across restarts) |
| Bad days | losses pile up | $3 per chain and $5 overall daily loss limits |

The trap pool is real: Base's Curve "USDPOOL" (`0x335BE1a3...`, USDC/USDT.b) answers one way to calls without a gas
price, which is how quotes are usually made, and another way inside transactions. It showed a 0.4% gap for hours.

### Speed

- **Estimate first, quote exactly second:** every route is estimated from one buy and one sell quote per pool and
  coin; only routes within 0.1% of covering their gas and the minimum profit get exact quotes, first at the size
  their estimate liked best. A full Base scan takes about 10 seconds at a $15 trade size; Base runs one every 15
  seconds (`<CHAIN>_INTERVAL_SEC`).
- **Chase mode (Kiyoshi's):** the route with a gap is re-checked every 5 seconds (1 second after a winning trade)
  and traded again while the gap lasts. Full scans still run, but the chase gets at least 2/3 of the time.
- **Less waste:** routes losing over 5% at every size are muted for an hour; quiet chains scan 2-3x less often; a
  trade in a watched pool triggers an instant rescan; each approval covers 25 trades (never unlimited).
- **Missed gaps:** a gap open 30 minutes on a chain that isn't trading it triggers a Telegram alert.

`SCAN_TIMING=1` prints how long each part of a scan took.

### Run it on Termux (Android)

```
pkg install nodejs git
cd ~ && git clone https://github.com/Midas3007/midas-arb && cd midas-arb
npm install
cp .env.example .env
npm run new-wallet          # a NEW wallet, only for this bot
nano .env                   # paste the key after HUNTER_PRIVATE_KEY=, keep HUNTER_LIVE=0
npm run check               # read-only: chains, exchanges, coins, fair prices
termux-wake-lock
npm run forever             # watch only; restarts by itself after a crash, Ctrl+C stops it
```

Updates: `git pull origin claude/focused-fermi-yqsxls && npm install`, then start again.

**Going live, safely:**
1. Watch first (`npm run report`, `/status`). Chains that saw real gaps go live by themselves after 3 days; to
   start one now, `/chain celo live` on Telegram.
2. Fund only those chains: a little gas token, plus cash (or gas token, which is converted).
3. Set `HUNTER_LIVE=1` and `TEST_TRADE=base`: the first scan makes one $2 round trip to prove the trade path.
4. Remove `TEST_TRADE`, set `SWEEP_TO=` your withdrawal address, and let it trade.

**Builder Codes (Base):** register the bot wallet once (`curl -X POST https://api.base.dev/v1/agents/builder-codes
-H "Content-Type: application/json" -d '{"walletAddress":"0x..."}'`) and put `BASE_BUILDER_CODE=bc_...` in `.env`
on the phone. Every Base transaction the bot sends then carries it (ERC-8021). Any chain: `<CHAIN>_BUILDER_CODE`.

### Chain lifecycle

| Mode | What happens | Moves on when |
|---|---|---|
| **watch** | scans, records what it would have earned (sized as if it held `WATCH_CAPITAL_USD`, $218), trades nothing | after 3 days with at least 5 gaps worth $0.10: **live** |
| **live** | trades (with `HUNTER_LIVE=1`) | no profit after gas over 7 days: **paused** |
| **paused / off** | does nothing at all (no scans, no RPC calls); its cash moves to live chains | paused by the rules: watch again after 7 days; off by hand: until you turn it on |

### Telegram

Create a bot with @BotFather, message it once, read your chat id from
`https://api.telegram.org/bot<TOKEN>/getUpdates`, put both in `.env`. Only your chat is obeyed. `/menu` opens the
command panel.

| Command | |
|---|---|
| `/status` | profit, each chain's mode, cash and results |
| `/scans` | each chain's latest scan line |
| `/gaps` | pools furthest from their peg |
| `/chains`, `/chain base live\|watch\|off\|auto` | set a chain by hand, or hand it back to the rules |
| `/only base` | every other chain off (`/chain all watch\|off\|auto` changes all but live chains) |
| `/switch celo` | move **all** the money (cash and gas token, Aave included) to one chain through LI.FI; that chain goes live, the others off. Shows the plan and costs first; `/switch` alone shows the gaps each chain saw in 24 h |
| `/withdraw` | sweep profit now |
| `/pause`, `/resume` | stop or restart new trades |

Alerts: start, trades of $1 or more, depeg freezes, new pools, chains promoted or paused, sweeps, failed second legs,
gaps left open.

### Money

The treasury runs every 10 minutes while `HUNTER_LIVE=1` (by hand: `npm run treasury -- --go`).

1. **Deposits:** gas token above a $2 reserve is swapped to the chain's cash token.
2. **Gas:** a chain short of gas buys $1 of it, or gets it bridged from the richest chain.
3. **Splitting:** cash goes to live chains by what each earns per dollar (each 5-40%); moves under $5 and bridges
   over 2% are skipped.
4. **Sweeping:** when profit after gas reaches $20, half is bridged to BSC as USDT to `SWEEP_TO` (or set aside in the
   wallet). `/withdraw` sweeps now.
5. **Idle cash** goes into Aave v3 where it earns at least 1%; **reward tokens** (Merkl) are claimed once worth $1.
6. **Trade size** grows with the money: up to 90% of the chain's cash (`TRADE_PCT`), at most $200
   (`MAX_TRADE_USD_CAP`); a trade must make at least $0.01 after gas (`MIN_NET_USD`).

---

## Gap survey

`npm run survey` quotes every currency coin on every venue pair (Textile included) at $25, $100 and $200, after gas,
every 2 minutes (`-- celo,base --rounds 10 --every 30 --sizes 25,100,200`). Quotes only, nothing is traded.
`npm run survey-report -- --md docs/FX_SURVEY.md` writes the summary. The last one is in
[docs/FX_SURVEY.md](docs/FX_SURVEY.md).

## Commands

| | |
|---|---|
| `npm start` / `npm run forever` | the trading bot (forever restarts it after a crash) |
| `npm run check` | read-only health check |
| `npm run report` | what each chain saw and earned (`-- 7` for a week) |
| `npm run treasury`, `npm run withdraw` | one treasury round or a sweep, plan only (`-- --go` to do it) |
| `npm run fx-api` | the FX quote API on its own |
| `npm run fx-pay -- <url>` | pay one API call from the bot wallet |
| `npm run survey`, `npm run survey-report` | the gap survey and its summary |
| `npm test`, `npm run typecheck` | 45 tests: engine, peg guards, fair price, lifecycle, splitting, sweeping, parking, rewards |

Every setting is listed in `.env.example`.

## Files

`data/state.json` (chain modes, sweep marks, money set aside), `data/ledger.jsonl` (every realized result),
`data/fx/history-*.jsonl` (the API's recorded quotes), and per chain `data/<chain>/`: `trades.jsonl`, `opps.jsonl`,
`scans.jsonl`, `pending.json` (leftovers), `curve-pools.json`, `textile.json`.

## Limits

- Not audited. Keep only trading capital in the bot wallet, and never put its key on the API server.
- Gaps come from other people's trades and FX moves; quiet days earn little. Watch first.
- Mento's oracles stop at weekends, so Mento routes close then; Textile and the pools keep trading.
- Each trade is two transactions. A one-transaction contract (no leftovers possible) is planned for chains that
  prove profitable ([docs/PEG_HUNTER_PLAN.md](docs/PEG_HUNTER_PLAN.md)).
- Not covered yet: Aerodrome's newer pool factories on Base (a cNGN/ZARP pool sits there), Balancer, Algebra
  exchanges on BSC.
