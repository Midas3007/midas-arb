// Counts transactions being sent right now (a trade's two legs, a bridge or a deposit). Ctrl+C exits at once
// when this is zero; otherwise it waits only for those to finish (Ctrl+C again forces it).
let n = 0
export const inflight = {
  get n() { return n },
  async run<T>(f: () => Promise<T>): Promise<T> { n++; try { return await f() } finally { n-- } },
}
