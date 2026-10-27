# Midas × Kiyoshi on-chain fund: notes and open decisions

Notes from the call with Mel (Kiyoshi is about to get a big upgrade). Scope: Midas's own Kiyoshi build, which
keeps pulling updates from Mel's repo.

## What was asked for
1. A smart contract for the fund (replaces the Supabase ledger).
2. A public landing page and dashboard.
3. Connect a wallet, deposit, and see your shares.
4. Fix any mismatch when someone sells shares while the bot is mid-trade or still earning.
5. Shares can be transferred.
6. The contract is connected to the wallet the bot trades from.
7. For Midas's version of Kiyoshi, which keeps pulling from Mel's.

## Decisions to make before writing code

| # | Decision | Options | Leaning |
|---|---|---|---|
| 1 | **Who holds the money** | (a) vault holds funds; bot trades *through* the vault via allow-listed exchanges only; (b) vault sends capital to the bot wallet; the bot reports the fund value | (a) is safer (a stolen bot key cannot drain the fund) but needs bot changes; (b) is simpler but members must trust the reported value |
| 2 | **How fund value is known** | on-chain read of balances (works for (a) on one chain); bot or keeper reports it (needed for (b) and multi-chain) | on-chain where possible; reported value with limits (max change per update) where not |
| 3 | **Deposits and withdrawals timing** | instant at the current share price; queued and settled when the bot is flat (ERC-7540 style), e.g. every hour or day | queued: this is what removes the "selling while the bot is mid-trade" mismatch and stops people jumping in right before a profit is booked |
| 4 | **Which chain the vault lives on** | Celo only (where Kiyoshi trades); one vault per chain; Celo vault with other chains reported | Celo first |
| 5 | **Fees** | 10% performance fee (as today) at fund level with a high-water mark, paid as new shares to the manager; management fee or not | fund-level high-water mark: per-person fee tracking breaks once shares are transferable |
| 6 | **Lock period / early-exit penalty** | keep the current ones; drop them | note: transferable shares let people exit by selling shares, which skips a lock |
| 7 | **Who may deposit** | anyone; allow-listed wallets only (members you approve) | allow-list at first (see Legal) |
| 8 | **Upgradeable or fixed contract** | fixed (simpler, trusted); upgradeable behind a timelock | fixed v1, migrate to v2 if needed |
| 9 | **Deposit limits** | per-person and total caps | a total cap while it is new, raised over time |

## Things easy to miss

**Contract and security**
- Admin keys: use a multisig (e.g. Safe with 2 of 3 signers), not one phone key. Put fee and setting changes
  behind a timelock so members can exit before a change applies.
- Emergency pause, and a way for members to withdraw even if the bot or keeper stops.
- The bot's key must not be able to send funds anywhere except allow-listed exchanges and the vault.
- First-deposit share-price attack on new vaults (ERC-4626 "inflation attack"): use the standard defence.
- Rounding always in the fund's favour; dust handling.
- Stablecoin risk: USDT/USDC depegs; decide what the share price is denominated in (USDT).
- Audit, or at least an independent review, before real money; testnet first, then a small cap on mainnet.
- Verified source code on Celoscan.

**Accounting**
- Leftover tokens from half-finished trades must count in the fund value (the bot already tracks them).
- Gas and bridge costs come out of the fund; show them.
- Migration: mint opening shares from the current ledger (today only Midas, $113.19, 19.36 units at $5.85).
- Records for members' taxes (deposit, withdrawal, price per share, dates).

**Legal and trust**
- A public pooled fund with transferable shares can count as a security or collective investment scheme
  (e.g. Nigerian SEC, and wherever members live). Get advice before opening it to the public; until then keep
  it invite-only (allow-list), with terms, risk disclosure, and blocked regions if needed.
- Kiyoshi's license and credit to Mel; keep the attribution tag.

**Landing page and dashboard**
- Wallet connection that works on phones: MiniPay and Valora (Celo wallets common in Nigeria), MetaMask,
  WalletConnect; automatic switch to Celo.
- Deposit flow: approve, deposit, then pending until the next settlement (if queued), then shares.
- Per wallet: shares, value, profit, pending deposits and withdrawals, history.
- Public: total value, share price chart, returns, fees taken, live bot activity, contract and bot wallet links.
- Risk disclosure the user must accept before the first deposit.
- Keep the private members' site (Supabase) working until the vault replaces it.
- Mobile first: most users will be on phones.

**Running it**
- A keeper that settles queued deposits and withdrawals and posts the fund value (who runs it, who pays gas).
- Alerts when the bot stops, the value drops, or the keeper misses an update.
- A written plan for incidents (pause, communicate, recover).

**Keeping up with Mel**
- Keep the fork following Mel's repo; keep fund-specific code separate so updates merge cleanly.
