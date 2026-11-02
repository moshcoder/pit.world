/**
 * Gives every page indexed before training verdicts were recorded a page_policy row, off the
 * main thread: reading a legacy page's language and date walks its full text's overflow pages
 * (about 3 s per 2,000 pages on the 14 GB index), which would stall the health server and the
 * loopback search. Its own connection; WAL lets the publisher keep writing alongside.
 */
import { IndexStore } from './index-store.ts'

declare const self: Worker

const path = process.env.CRAWL_INDEX_PATH ?? './data/index.db'
const store = new IndexStore(path)
let total = 0
while (true) {
  let n = 0
  try {
    n = store.mapLegacy(500)
  } catch (error) {
    // Busy with the publisher: wait and try again.
    self.postMessage({ error: (error as Error).message })
    await Bun.sleep(5_000)
    continue
  }
  total += n
  if (!n) break
  await Bun.sleep(50)
}
store.close()
self.postMessage({ done: total })
