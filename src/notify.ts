// Optional Telegram alerts. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env (see README); otherwise silent.
const token = process.env.TELEGRAM_BOT_TOKEN ?? ''
const chat = process.env.TELEGRAM_CHAT_ID ?? ''

export function notify(text: string) {
  if (!token || !chat) return
  fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {}) // alerts must never break trading
}
