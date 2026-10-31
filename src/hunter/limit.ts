// At most `n` tasks at once (per chain). Firing hundreds of quotes at a free public RPC gets them throttled and
// makes every chain slow; a small queue is faster overall, and kind to a phone.
export function limiter(n: number) {
  let active = 0
  const queue: (() => void)[] = []
  const next = () => { if (active < n && queue.length) { active++; queue.shift()!() } }
  return <T>(f: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    queue.push(() => { f().then(resolve, reject).finally(() => { active--; next() }) })
    next()
  })
}
