# Currency-pegged coins: found, verified, listed (31 Oct 2026)

How each coin was checked:
1. **Found** in LI.FI's token lists, CoinGecko's listings and Textile's address book.
2. **On-chain:** the contract exists, and its symbol, name and decimals match. Supply is valued at the fair rate.
3. **Tradable:** a $5 quote from the chain's cash token (LI.FI, across every exchange it knows). The % shows how
   far that price was from the fair rate. Gnosis shows "no route" because LI.FI doesn't quote WXDAI; Peg Hunter
   trades Gnosis through Curve.
4. **Textile:** a $5 preview quote against each dollar coin on the chain.
5. **Fair price:** at least two agreeing sources for the currency.

The bot re-checks every address on-chain at each start (`npm run check`), so a wrong one is skipped, never traded.

## In Peg Hunter

| Chain | Coin | Currency | Supply | $5 test price vs fair | Textile | |
|---|---|---|---|---|---|---|
| Celo | cNGN | NGN | $142k | -1.8% | ✅ USDT | |
| Celo | wBRL | BRL | $715k | +1.4% | ✅ USDT | |
| Celo | wARS | ARS | $208k | -6.9% (street vs official rate) | ✅ USDT | |
| Celo | wCOP | COP | $11k | Textile +2.1% | ✅ USDT | new |
| Celo | wMXN | MXN | $0.7k | - | corridor listed, no quote now | new |
| Celo | USAT | USD | $328k | +0.2% | ✅ USDT | new |
| Celo | IDRX | IDR | $1.3M | Textile only | ✅ USDT | new |
| Celo | BRLA | BRL | $33.5M | +1.1% | | new |
| Celo | CHFm, EURA | CHF, EUR | $63k, $85k | +3.4%, -1.8% | | new |
| Celo | Mento: EURm BRLm KESm XOFm PHPm COPm GHSm (+NGNm etc. from Mento) | | | | | |
| Base | EURC | EUR | $55.6M | +0.2% | | |
| Base | cNGN | NGN | $1.8M | -1.6% | ✅ USDC | Textile venue added |
| Base | IDRX, CADC, BRZ, ZARP | IDR, CAD, BRL, ZAR | $236k-$1.7M | -0.5%..+1.0% | | |
| Base | MXNB | MXN | $795k | +0.7% | | new |
| Base | XSGD | SGD | $3.3M | +0.3% | | new |
| Base | ZCHF, VCHF | CHF | $2.1M, $578k | +0.1%, 0.0% | | new |
| Base | EURA, EURAU, EURe | EUR | $13k-$29k | -4.2%..+0.6% | | new |
| Base | TRYB | TRY | $11k | +3.8% | | new |
| Base | wARS | ARS | $1.1M | -6.6% | | new |
| Base | ZARU | ZAR | ~0 (launched 2026) | - | corridor listed | new |
| Base | MXNe | MXN | $5k | -42% (pool abandoned; guards skip it) | | kept |
| BSC | cNGN | NGN | $1.2M | -1.6% | ✅ USDT | Textile venue added |
| BSC | BRZ | BRL | $18.4M | +2.4% | | |
| BSC | IDRX, EURI | IDR, EUR | $77k, $3.3M | +0.6%, +2.6% | | |
| BSC | EURA | EUR | $32k | -1.7% | | new |
| BSC | TRYB | TRY | $189k | +737% (dead pool; guards skip it) | | kept |
| Polygon | BRZ, BRLA, wBRL | BRL | $10.8M, $3.4M, $14k | -0.4%, +0.2%, +1.4% | | BRLA, wBRL new |
| Polygon | EURe (Monerium v2) | EUR | $2.8M | +0.5% | | replaces v1 (no route) |
| Polygon | XSGD, EURS, jEUR, EURA | SGD, EUR | $81k-$1.5M | -0.2%..+1.3% | | EURA new |
| Polygon | JPYC (current) | JPY | $47.9M | +0.1% | | new |
| Polygon | ZARP, CADC, ZCHF | ZAR, CAD, CHF | $48k-$600k | 0%..+2.9% | | new |
| Polygon | IDRX, cNGN, TRYB, jCHF, jGBP | | | jCHF -37%, jGBP -18%, TRYB +57% (guards skip) | | kept |
| Arbitrum | EURe | EUR | $6.0M | +0.9% | | |
| Arbitrum | MXNB | MXN | $2.8M | +0.6% | | new |
| Arbitrum | EURA | EUR | $95k | +0.6% | | new |
| Optimism | EURC | EUR | $2.9M | +0.3% | | new |
| Optimism | ZCHF, EURA | CHF, EUR | $1.4M, $35k | +0.2%, -0.8% | | ZCHF new |
| Avalanche | EURC, XSGD | EUR, SGD | $4.2M, $1.3M | +0.1%, +0.2% | | XSGD new |
| Avalanche | BRZ | BRL | $18.4M | +4.9% | | new |
| Avalanche | MXNB, TRYB | MXN, TRY | $123k, $218k | -1.5%, +11.9% | | new |
| Avalanche | VCHF, JPYC | CHF, JPY | $663k, $635k | no route yet | | new |
| Gnosis | EURe, GBPe | EUR, GBP | $16.5M, $676k | Curve | | |
| Gnosis | EURA, BRLA, JPYC | EUR, BRL, JPY | $99k, $527k, $32k | | | new |

## Found but not added

| Chain | Coin | Why |
|---|---|---|
| Arbitrum | "PEN" | it is "Pentagon", not the Peruvian sol |
| Polygon | JPYC 0x431D…, 0x6AE7… | older JPYC versions, trading ~45% off |
| Polygon | EURe v1 0x18ec… | no route; replaced by Monerium v2 |
| Optimism | sUSD | officially retired ("Synth sUSD (retired)") |
| Polygon | VCHF, MXNB, EURAU | supply $0-2k |
| Arbitrum | XSGD, BRZ, ZCHF, GBPe, USAT, EURS | supply $0-48k or EURS 17% off |
| Avalanche | EURA, ZCHF, BRZ (18-dec) | supply ≤$171k and no route |
| Gnosis | ZCHF, EURS, IDRX | supply $0-2k |
| BSC / Avalanche | BRZ 18-decimal copies | $13k-$171k, no route; the 4-decimal BRZ is the main one |
| Base, Polygon | TESOURO (Textile) | a tokenized Brazilian treasury **bond**: its value grows, so there's no fixed fair price |
| Celo | G$ (Textile "GD") | GoodDollar, a universal-basic-income token, not tied to a currency |
| Ethereum | wBRL, BRS (Textile) | mainnet gas is too dear |
| Base | nTZS (Textile ticker NTZS) | launched on Base, but no official address published anywhere I could find |

## The official-rate catch

The free FX feeds give the **official** exchange rate. For the naira and the Argentine peso, crypto trades nearer the
street rate: cNGN sat 1.6-2.0% "cheap" on every chain and at Textile, and wARS about 6.7%. These are not gaps. Round
trips are unaffected (they compare two real prices). The depeg guard allows them wider limits (NGN 5%, ARS 12%;
`DEPEG_PCT_CCY`).

## Textile per chain (docs.textilecredit.com/protocol/address-book)

| Chain | Reactor | Live corridors | In Peg Hunter |
|---|---|---|---|
| Celo | 0xa9AA0a64… | cNGN, USDC, wARS, wBRL, IDRX, wCOP, wMXN, CELO, WETH, USAT, G$ ↔ USDT; cNGN ↔ G$ | yes |
| Base | 0xEb5A29F8… | cNGN, TESOURO, ZARU ↔ USDC | yes (cNGN, ZARU) |
| BSC | 0xe03261c0… | cNGN ↔ USDT | yes |
| Polygon | 0xF3ffCF21… | TESOURO ↔ USDT | no (bond) |
| Ethereum | 0x26A1aeda… | WETH, wBRL, BRS ↔ USDT | no (gas) |
