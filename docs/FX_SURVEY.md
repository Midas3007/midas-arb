# Where the FX gaps are (survey, 6 Nov 2026)

`npm run survey` quoted every currency coin on Celo, Base, BSC and Polygon, every 2.6 minutes for 65 minutes (25
rounds): $25, $100 and $200 bought on each exchange that has the coin (Textile included), then sold on every other
one, with honest quotes (a real gas price on every call) and gas counted. Nothing was traded.

## What it says

- **The gaps are on Celo, Textile against Uniswap, in Kiyoshi's pairs.** wARS Textile -> Uniswap paid in 2 of 25
  rounds (+$0.011 and +$0.005 on $100); cNGN Textile -> Uniswap sat at -0.002% (it flickers across zero). These are
  small and short: a sample every 2.6 minutes sees few of them. Kiyoshi's good days come from moments when one side
  moves (a big trade in the Uniswap pool, an FX move Textile follows first); the bot's chase mode and pool-trade
  watcher are built for those moments, the survey is not.
- **Base: EURC Uniswap -> Aerodrome at -0.005%**, a dollar-pool-to-dollar-pool euro route, nearly paying. Worth
  watching: Base gas is the cheapest.
- **Textile on Base and BSC has nothing to trade against.** cNGN prices fine at Textile there (-2.2% from the official
  rate, the market rate), but the DEX pools are empty or broken (Base aerodrome-v2, BSC Pancake about -10%).
- **Polygon:** nothing within 0.5% (best: BRZ -0.49%).
- **Mento coins on Celo** (KESm, NGNm, PHPm, GHSm...): Mento's spread plus the Uniswap pools keep every route 0.3-4%
  under water.
- **wBRL on Celo:** Uniswap prices it 2.8% above fair and Textile 0.6% below, but the Uniswap pool is too thin to
  sell into at these sizes.

## What changed because of it

- The bot's default chains are now **Celo and Base** (`HUNTER_CHAINS=celo,base,bsc,polygon` to watch all four).
  BSC and Polygon stay in the FX quote API, where coverage is the point.
- On Celo, the paying routes are exactly Kiyoshi's. Two bots on the same routes race each other for the same
  cents; one bot with the combined money takes more.


## The numbers

A round quotes every currency coin at each size on every exchange that has it, then sells what that bought on every other exchange (Textile included). "Paid" means after gas. Quotes only, nothing was traded.

| Chain | Coin | Rounds a route paid | Best paid (route, size, after gas) | Closest route (% of the trade) | Best Textile route |
|---|---|---|---|---|---|
| celo | wARS (ARS) | 2 of 25 | textile -> uniswap $100: +$0.011 | textile -> uniswap $100: 0.011% | textile -> uniswap $100: 0.011% |
| celo | cNGN (NGN) | 0 of 25 | - | textile -> uniswap $100: -0.002% | textile -> uniswap $100: -0.002% |
| base | EURC (EUR) | 0 of 25 | - | uniswap -> aerodrome $100: -0.005% | - |
| base | XSGD (SGD) | 0 of 25 | - | aerodrome -> uniswap $100: -0.088% | - |
| celo | VGBP (GBP) | 0 of 25 | - | uniswap -> textile $25: -0.139% | uniswap -> textile $25: -0.139% |
| celo | PHPm (PHP) | 0 of 25 | - | uniswap -> mento $25: -0.324% | - |
| celo | NGNm (NGN) | 0 of 25 | - | mento -> uniswap $100: -0.341% | - |
| celo | BRLm (BRL) | 0 of 25 | - | mento -> uniswap $25: -0.389% | - |
| polygon | BRZ (BRL) | 0 of 25 | - | uniswap-v4/0.05% -> uniswap $25: -0.487% | - |
| celo | COPm (COP) | 0 of 25 | - | uniswap-v4/0.01% -> mento $25: -0.664% | - |
| celo | KESm (KES) | 0 of 25 | - | mento -> uniswap $200: -0.675% | - |
| celo | GHSm (GHS) | 0 of 25 | - | uniswap -> mento $25: -1.121% | - |
| celo | XOFm (XOF) | 0 of 25 | - | uniswap -> mento $25: -2.269% | - |
| celo | AUDm (AUD) | 0 of 25 | - | uniswap -> mento $200: -3.323% | - |
| celo | wBRL (BRL) | 0 of 25 | - | uniswap -> textile $25: -3.337% | uniswap -> textile $25: -3.337% |
| celo | ZARm (ZAR) | 0 of 25 | - | mento -> uniswap $25: -4.232% | - |
| celo | CADm (CAD) | 0 of 25 | - | mento -> uniswap $25: -4.356% | - |
| bsc | cNGN (NGN) | 0 of 25 | - | textile -> pancake $25: -9.913% | textile -> pancake $25: -9.913% |
| polygon | BRLA (BRL) | 0 of 25 | - | uniswap-v4/0.01% -> uniswap $25: -10.502% | - |
| celo | VCHF (CHF) | 0 of 25 | - | uniswap -> textile $25: -27.152% | uniswap -> textile $25: -27.152% |
| base | MXNe (MXN) | 0 of 25 | - | aerodrome -> aerodrome-v2 $25: -37.744% | - |
| base | IDRX (IDR) | 0 of 25 | - | aerodrome-v2 -> uniswap $25: -84.360% | - |
| polygon | EURA (EUR) | 0 of 25 | - | uniswap -> sushi $25: -99.636% | - |
| base | EURA (EUR) | 0 of 25 | - | aerodrome-v2 -> uniswap $25: -99.641% | - |
| base | CADC (CAD) | 0 of 25 | - | aerodrome-v2 -> aerodrome $200: -100.002% | - |
| base | VCHF (CHF) | 0 of 25 | - | aerodrome -> aerodrome-v2 $200: -100.002% | - |
| base | cNGN (NGN) | 0 of 25 | - | textile -> aerodrome-v2 $200: -100.003% | textile -> aerodrome-v2 $200: -100.003% |

## Where each exchange prices the coin (median, % above fair when buying $100; broken pools left out)

| Chain | Coin | Exchange: price vs fair |
|---|---|---|
| base | EURC | uniswap -0.64%, aerodrome -0.65%, pancake -0.64%, aerodrome-v2 +10.89%, curve -0.26%, uniswap-v4/0.05% -0.45% |
| base | XSGD | uniswap -0.12%, aerodrome -0.16% |
| base | cNGN | textile -2.20% |
| bsc | EURA | pancake -2.54% |
| bsc | EURI | pancake +4.84% |
| bsc | IDRX | pancake -0.02% |
| bsc | cNGN | textile -2.22% |
| celo | AUDm | uniswap +2.22% |
| celo | BRLA | uniswap -0.02% |
| celo | BRLm | uniswap +1.69%, mento -0.23% |
| celo | CADm | mento -0.31% |
| celo | COPm | mento +0.43%, uniswap-v4/0.01% +2.63% |
| celo | EURm | uniswap +0.01% |
| celo | GHSm | uniswap +1.29%, mento +1.14% |
| celo | KESm | uniswap +0.49%, mento +1.15% |
| celo | NGNm | uniswap +0.84%, mento +1.19% |
| celo | PHPm | uniswap +0.64%, mento +0.50% |
| celo | VGBP | uniswap +0.06% |
| celo | XOFm | uniswap +1.49%, mento +1.98% |
| celo | ZARm | uniswap +18.99%, mento +0.10% |
| celo | cNGN | uniswap -2.19%, textile -2.22% |
| celo | wARS | uniswap -6.73%, textile -6.73% |
| celo | wBRL | uniswap +2.83%, textile -0.55% |
| polygon | BRLA | uniswap -1.29% |
| polygon | BRZ | uniswap -1.39% |
| polygon | EURS | uniswap +4.12% |
| polygon | IDRX | uniswap +0.14% |
| polygon | JPYC | uniswap +0.11% |
| polygon | XSGD | uniswap +0.00% |
