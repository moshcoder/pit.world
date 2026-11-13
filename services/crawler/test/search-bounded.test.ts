import { afterAll, expect, test } from 'bun:test'
import { listen, type Socket } from 'bun'
import { toFtsTerms, withoutStopwords } from '../src/index-store.ts'
import { PgIndexStore } from '../src/pg-index-store.ts'

test('stopwords go when other words remain', () => {
  expect(withoutStopwords(toFtsTerms('Join the conversation'))).toEqual(['"join"', '"conversation"'])
  expect(withoutStopwords(toFtsTerms('the rust'))).toEqual(['"rust"'])
  // Nothing but stopwords: keep them, an empty search finds nothing.
  expect(withoutStopwords(toFtsTerms('to be or'))).toEqual(['"to"', '"be"', '"or"'])
})

// A "Postgres" that takes the connection and never says a word: how the index looked on 2026-11-13.
const sockets: Socket[] = []
const silent = listen({ hostname: '127.0.0.1', port: 0, socket: { open: (s) => void sockets.push(s), data() {} } })
afterAll(() => {
  for (const s of sockets) s.end()
  silent.stop(true)
})

test('a search Postgres never answers gives nothing by the deadline, and busy slots answer at once', async () => {
  const store = new PgIndexStore(`postgres://u:p@127.0.0.1:${silent.port}/db`, 0, { searchMax: 2, searchDeadlineMs: 300 })
  let t = Date.now()
  const [a, b] = await Promise.all([store.search('rust', 10), store.search('join the conversation', 10)])
  expect(a).toEqual([])
  expect(b).toEqual([])
  expect(Date.now() - t).toBeLessThan(1_500)
  // Both slots are still held by the stuck queries: the next search does not queue behind them.
  t = Date.now()
  expect(await store.search('rust', 10, 'product')).toEqual([])
  expect(Date.now() - t).toBeLessThan(100)
})
