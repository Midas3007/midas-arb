// Telegram commands (only from TELEGRAM_CHAT_ID; everyone else is ignored):
//   /status            profit, each chain's mode, cash and results
//   /chains            each chain's mode and why
//   /chain base live   force a chain live (also: watch, off, auto = back to the automatic rules)
//   /gaps              pools furthest from their peg right now
//   /withdraw          sweep profit now (ignores SWEEP_AT_USD; the fee and $3 rules still apply)
//   /pause  /resume    stop or restart all new trades (leftovers are still sold by the loss guard)
//   /menu              the command panel: buttons for all of the above, edited in place
//   /scans             each chain's latest scan line (what it is seeing right now)
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
  const byKind = (kinds: string[]) => L.entries.reduce((a, e) => a + (kinds.includes(e.kind) && keys.includes(e.chain) ? e.net : 0), 0)
  const unswept = keys.reduce((a, k) => a + Math.max(0, L.cum(k) - (S.marks[k] ?? 0)), 0)
  const lines = [
    `Peg Hunter ${ctx.live ? 'LIVE' : 'WATCH ONLY'}${S.paused ? ' (PAUSED)' : ''}`,
    `profit all time ${money(total)}, today ${money(L.today(null))}; not yet swept ${money(unswept)}, swept $${S.sweptUsd.toFixed(2)}`,
    `from: trades ${money(byKind(['trade', 'flatten']))}, Aave interest ${money(byKind(['yield']))}, rewards ${money(byKind(['reward']))}, fees ${money(byKind(['fee']))}`,
  ]
  for (const k of keys) {
    const c = S.chains[k], st = ctx.status.get(k)
    const days = ((now - c.since) / 86_400_000).toFixed(1)
    const res = c.mode === 'watch' ? `seen ${c.watchOpps} gaps worth $${c.watchUsd.toFixed(2)}` : `7d ${money(L.since(k, week))}, today ${money(L.today(k))}`
    const aave = st && st.parkedUsd > 0.005 ? ` ($${st.parkedUsd.toFixed(2)} earning ${st.apyPct.toFixed(1)}%)` : ''
    lines.push(`${k}: ${c.mode}${c.manual ? '*' : ''} ${days}d | $${(st?.cashUsd ?? 0).toFixed(2)}${aave} | ${res}${st?.error ? ` | ${st.error}` : ''}`)
  }
  lines.push('(* = set by hand)')
  return lines.join('\n')
}

// The command panel: buttons under a message. Tapping one edits that message in place, so the chat stays tidy.
type Btn = { text: string; callback_data: string }
const kb = (rows: Btn[][]) => ({ inline_keyboard: rows })
const MAIN: Btn[][] = [
  [{ text: '📊 Status', callback_data: 'status' }, { text: '📡 Scans', callback_data: 'scans' }],
  [{ text: '🎯 Gaps', callback_data: 'gaps' }, { text: '⛓ Chains', callback_data: 'chains' }],
  [{ text: '💸 Withdraw', callback_data: 'withdraw?' }, { text: '⏯ Pause / Resume', callback_data: 'toggle' }],
]
const back: Btn[] = [{ text: '« Menu', callback_data: 'menu' }]

export async function telegramLoop(ctx: Ctx, keys: string[]) {
  if (!token || !chat) return
  let offset = 0
  const S = () => ctx.store.state
  const send = (text: string, markup?: object) => api('sendMessage', { chat_id: chat, text: text.slice(0, 4000), disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) }).catch(() => {})
  const edit = (msgId: number, text: string, markup?: object) =>
    api('editMessageText', { chat_id: chat, message_id: msgId, text: text.slice(0, 4000), disable_web_page_preview: true, reply_markup: markup ?? kb([back]) })
      .then((r: any) => { if (!r?.ok && !String(r?.description).includes('not modified')) return send(text, markup ?? kb([back])) }).catch(() => {})

  // The "/" menu in the chat bar.
  await api('setMyCommands', { commands: [
    { command: 'menu', description: 'Command panel' },
    { command: 'status', description: 'Profit and each chain' },
    { command: 'scans', description: 'What each chain is seeing now' },
    { command: 'gaps', description: 'Pools furthest from their peg' },
    { command: 'chains', description: 'Modes, and switch a chain' },
    { command: 'withdraw', description: 'Sweep profit now' },
    { command: 'pause', description: 'Stop new trades' },
    { command: 'resume', description: 'Restart trading' },
  ] }).catch(() => {})

  const chainsText = () => keys.map((k) => {
    const c = S().chains[k]
    return `${k}: ${c.mode}${c.manual ? ' (by hand)' : ''} since ${new Date(c.since).toISOString().slice(0, 16).replace('T', ' ')}${c.note ? `\n   ${c.note}` : ''}`
  }).join('\n')
  const chainButtons = (): Btn[][] => {
    const rows: Btn[][] = []
    for (let i = 0; i < keys.length; i += 3) rows.push(keys.slice(i, i + 3).map((k) => ({ text: `${k} · ${S().chains[k].mode}${S().chains[k].manual ? '*' : ''}`, callback_data: `chain:${k}` })))
    return [...rows, back]
  }
  const setChain = (k: string, what: string) => {
    if (what === 'auto') S().chains[k].manual = false
    else S().chains[k] = { ...freshState(what === 'off' ? 'paused' : (what as 'live' | 'watch'), Date.now(), `set to ${what} on Telegram`), manual: true }
    ctx.store.save()
    return `${k} is now ${S().chains[k].mode}${S().chains[k].manual ? ' (set by hand)' : ' (automatic rules)'}`
  }
  const scansText = () => keys.map((k) => {
    const st = ctx.status.get(k)
    const ago = st?.lastScanAt ? `${Math.round((Date.now() - st.lastScanAt) / 1000)}s ago` : 'not yet'
    return `${k} (${ago}${st ? `, ${st.routes} routes, swap $${st.swapGasUsd.toFixed(4)}` : ''}): ${st?.error ?? st?.lastLine ?? 'starting'}`
  }).join('\n')
  const gapsText = (min: number) => {
    const off = ctx.board.offPeg(min).slice(0, 15)
    return off.length ? `Pools off their peg by ${min}% or more:\n` + off.map((o) => `${o.chain} ${o.token} ${o.venue}: ${(o.dev * 100).toFixed(2)}%`).join('\n')
      : `No pool is off its peg by ${min}% or more right now.`
  }
  const withdraw = async () => {
    const out: string[] = []
    await treasuryRound({ store: ctx.store, ledger: ctx.ledger, locks: ctx.locks, chains: keys.map((k) => CHAINS[k]), say: (x) => out.push(x) }, { go: ctx.live, forceSweep: true })
    return out.filter((l) => /sweep|profit|waiting|plan only|swept|set aside/i.test(l)).join('\n') || 'nothing to sweep'
  }
  const toggle = () => { S().paused = !S().paused; ctx.store.save(); return S().paused ? '⏸ Paused: no new trades (leftovers are still sold).' : '▶️ Resumed.' }

  // Buttons
  async function onButton(q: any) {
    const id = q.message?.message_id, data: string = q.data ?? ''
    api('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {})
    if (data === 'menu') return edit(id, 'Peg Hunter: choose', kb(MAIN))
    if (data === 'status') return edit(id, statusText(ctx, keys), kb([[{ text: '🔄 Refresh', callback_data: 'status' }], back]))
    if (data === 'scans') return edit(id, scansText(), kb([[{ text: '🔄 Refresh', callback_data: 'scans' }], back]))
    if (data.startsWith('gaps')) {
      const min = Number(data.split(':')[1] ?? '0.5')
      return edit(id, gapsText(min), kb([[0.2, 0.5, 1, 3].map((m) => ({ text: `≥${m}%`, callback_data: `gaps:${m}` })), back]))
    }
    if (data === 'chains') return edit(id, `${chainsText()}\n\nTap a chain to switch it (* = set by hand):`, kb(chainButtons()))
    if (data.startsWith('chain:')) {
      const k = data.slice(6)
      return edit(id, `${k}: ${S().chains[k].mode}${S().chains[k].manual ? ' (by hand)' : ' (automatic)'}\n${S().chains[k].note ?? ''}`, kb([
        [{ text: '🟢 live', callback_data: `set:${k}:live` }, { text: '👀 watch', callback_data: `set:${k}:watch` }],
        [{ text: '⛔ off', callback_data: `set:${k}:off` }, { text: '🤖 auto', callback_data: `set:${k}:auto` }],
        [{ text: '« Chains', callback_data: 'chains' }],
      ]))
    }
    if (data.startsWith('set:')) {
      const [, k, what] = data.split(':')
      if (!keys.includes(k)) return
      return edit(id, setChain(k, what), kb([[{ text: '« Chains', callback_data: 'chains' }], back]))
    }
    if (data === 'withdraw?') return edit(id, ctx.live ? 'Sweep profit to the withdrawal chain now?' : 'Watch only (HUNTER_LIVE=0): this shows the plan, nothing moves.', kb([[{ text: '✅ Yes, sweep', callback_data: 'withdraw!' }, { text: 'Cancel', callback_data: 'menu' }]]))
    if (data === 'withdraw!') { await edit(id, 'Sweeping…', kb([])); return edit(id, await withdraw()) }
    if (data === 'toggle') return edit(id, toggle(), kb(MAIN))
  }

  // Typed commands (still work, for muscle memory)
  async function onText(text: string) {
    const [cmd, ...args] = text.trim().split(/\s+/)
    switch (cmd.split('@')[0].toLowerCase()) {
      case '/start': case '/menu': return send('Peg Hunter: choose', kb(MAIN))
      case '/status': return send(statusText(ctx, keys), kb([[{ text: '🔄 Refresh', callback_data: 'status' }], back]))
      case '/scans': return send(scansText(), kb([[{ text: '🔄 Refresh', callback_data: 'scans' }], back]))
      case '/gaps': return send(gapsText(Number(args[0] ?? '0.5')), kb([back]))
      case '/chains': return send(`${chainsText()}\n\nTap a chain to switch it (* = set by hand):`, kb(chainButtons()))
      case '/chain': {
        const [k, what] = [args[0]?.toLowerCase(), args[1]?.toLowerCase()]
        if (!k || !keys.includes(k) || !['live', 'watch', 'off', 'auto'].includes(what ?? '')) return send(`usage: /chain <${keys.join('|')}> live|watch|off|auto`)
        return send(setChain(k, what))
      }
      case '/withdraw': return send(ctx.live ? 'Sweep profit to the withdrawal chain now?' : 'Watch only: this shows the plan, nothing moves.', kb([[{ text: '✅ Yes, sweep', callback_data: 'withdraw!' }, { text: 'Cancel', callback_data: 'menu' }]]))
      case '/pause': if (!S().paused) toggle(); return send('⏸ Paused: no new trades (leftovers are still sold).', kb(MAIN))
      case '/resume': if (S().paused) toggle(); return send('▶️ Resumed.', kb(MAIN))
      default: return send('Peg Hunter: choose', kb(MAIN))
    }
  }

  while (!ctx.stopping()) {
    const j = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }).catch(() => null)
    if (!j?.ok) { await new Promise((r) => setTimeout(r, 5000)); continue }
    for (const u of j.result) {
      offset = u.update_id + 1
      try {
        // Only your chat is obeyed; everyone else is ignored.
        if (u.callback_query && String(u.callback_query.message?.chat?.id) === chat) await onButton(u.callback_query)
        else if (u.message?.text && String(u.message.chat?.id) === chat) await onText(u.message.text)
      } catch (e: any) { await send(`error: ${String(e?.message ?? e).split('\n')[0]}`) }
    }
  }
}

export { notify }
