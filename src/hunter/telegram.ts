// Telegram commands (only from TELEGRAM_CHAT_ID; everyone else is ignored):
//   /status            profit, each chain's mode, cash and results
//   /chains            each chain's mode and why
//   /chain base live   force a chain live (also: watch, off, auto = back to the automatic rules)
//   /gaps              pools furthest from their peg right now
//   /withdraw          sweep profit now (ignores SWEEP_AT_USD; the fee and $3 rules still apply)
//   /pause  /resume    stop or restart all new trades (leftovers are still sold by the loss guard)
import { notify } from '../notify.js'
import { CHAINS } from './chains.js'
import type { Ctx } from './desk.js'
import { freshState, LIFECYCLE } from './policy.js'
import { treasuryRound } from './treasury.js'

const token = process.env.TELEGRAM_BOT_TOKEN ?? ''
const chat = process.env.TELEGRAM_CHAT_ID ?? ''
const api = (m: string, body: object) => fetch(`https://api.telegram.org/bot${token}/${m}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(40_000),
}).then((r) => r.json() as any)
const money = (x: number) => `${x >= 0 ? '+' : '-'}$${Math.abs(x).toFixed(x !== 0 && Math.abs(x) < 0.1 ? 4 : 2)}`

export function statusText(ctx: Ctx, keys: string[]): string {
  const S = ctx.store.state, L = ctx.ledger, now = Date.now(), week = now - LIFECYCLE.reviewDays * 86_400_000
  const total = keys.reduce((a, k) => a + L.cum(k), 0)
  const unswept = keys.reduce((a, k) => a + Math.max(0, L.cum(k) - (S.marks[k] ?? 0)), 0)
  const lines = [
    `Peg Hunter ${ctx.live ? 'LIVE' : 'WATCH ONLY'}${S.paused ? ' (PAUSED)' : ''}`,
    `profit all time ${money(total)}, today ${money(L.today(null))}; not yet swept ${money(unswept)}, swept $${S.sweptUsd.toFixed(2)}`,
  ]
  for (const k of keys) {
    const c = S.chains[k], st = ctx.status.get(k)
    const days = ((now - c.since) / 86_400_000).toFixed(1)
    const res = c.mode === 'watch' ? `seen ${c.watchOpps} gaps worth $${c.watchUsd.toFixed(2)}` : `7d ${money(L.since(k, week))}, today ${money(L.today(k))}`
    lines.push(`${k}: ${c.mode}${c.manual ? '*' : ''} ${days}d | $${(st?.cashUsd ?? 0).toFixed(2)} | ${res}${st?.error ? ` | ${st.error}` : ''}`)
  }
  lines.push('(* = set by hand)')
  return lines.join('\n')
}

export async function telegramLoop(ctx: Ctx, keys: string[]) {
  if (!token || !chat) return
  let offset = 0
  const reply = (text: string) => api('sendMessage', { chat_id: chat, text: text.slice(0, 4000), disable_web_page_preview: true }).catch(() => {})
  while (!ctx.stopping()) {
    const j = await api('getUpdates', { offset, timeout: 25 }).catch(() => null)
    if (!j?.ok) { await new Promise((r) => setTimeout(r, 5000)); continue }
    for (const u of j.result) {
      offset = u.update_id + 1
      const m = u.message
      if (!m?.text || String(m.chat?.id) !== chat) continue
      const [cmd, ...args] = m.text.trim().split(/\s+/)
      const S = ctx.store.state
      try {
        switch (cmd.split('@')[0].toLowerCase()) {
          case '/status': await reply(statusText(ctx, keys)); break
          case '/chains':
            await reply(keys.map((k) => `${k}: ${S.chains[k].mode}${S.chains[k].manual ? ' (by hand)' : ''} since ${new Date(S.chains[k].since).toISOString().slice(0, 16)}${S.chains[k].note ? `\n  ${S.chains[k].note}` : ''}`).join('\n'))
            break
          case '/chain': {
            const [k, what] = [args[0]?.toLowerCase(), args[1]?.toLowerCase()]
            if (!k || !keys.includes(k) || !['live', 'watch', 'off', 'auto'].includes(what ?? '')) { await reply(`usage: /chain <${keys.join('|')}> live|watch|off|auto`); break }
            if (what === 'auto') S.chains[k].manual = false
            else S.chains[k] = { ...freshState(what === 'off' ? 'paused' : (what as 'live' | 'watch'), Date.now(), `set to ${what} on Telegram`), manual: true }
            ctx.store.save()
            await reply(`${k} is now ${S.chains[k].mode}${S.chains[k].manual ? ' (by hand; /chain ' + k + ' auto to undo)' : ' (automatic rules)'}`)
            break
          }
          case '/gaps': {
            const off = ctx.board.offPeg(Number(args[0] ?? '0.5')).slice(0, 15)
            await reply(off.length ? off.map((o) => `${o.chain} ${o.token} ${o.venue}: ${(o.dev * 100).toFixed(2)}%`).join('\n') : 'no pool is off its peg by that much right now')
            break
          }
          case '/withdraw': {
            const out: string[] = []
            await treasuryRound({ store: ctx.store, ledger: ctx.ledger, locks: ctx.locks, chains: keys.map((k) => CHAINS[k]), say: (s) => out.push(s) }, { go: ctx.live, forceSweep: true })
            await reply(out.filter((l) => /sweep|profit|waiting|plan only|swept/i.test(l)).join('\n') || 'nothing to sweep')
            break
          }
          case '/pause': S.paused = true; ctx.store.save(); await reply('paused: no new trades (leftovers are still sold). /resume to restart.'); break
          case '/resume': S.paused = false; ctx.store.save(); await reply('resumed'); break
          default: await reply('/status  /chains  /chain <chain> live|watch|off|auto  /gaps  /withdraw  /pause  /resume')
        }
      } catch (e: any) { await reply(`error: ${String(e?.message ?? e).split('\n')[0]}`) }
    }
  }
}

export { notify }
