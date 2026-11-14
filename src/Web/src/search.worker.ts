import { ApiError } from '../../Contracts/aeds.ts'
import { searchCorpus } from '../../Contracts/local-search.ts'

type SearchRequest = { query: string; page: number; size: number }

self.addEventListener('message', async ({ data }: MessageEvent<SearchRequest>) => {
  try {
    const { frame, generation } = await searchCorpus(data.query, undefined, data.page, data.size)
    self.postMessage({ ok: true, frame, generation }, { transfer: [frame.buffer] })
  } catch (error) {
    self.postMessage({
      ok: false,
      status: error instanceof ApiError ? error.status : 0,
      message: error instanceof Error ? error.message : 'Search worker failed',
    })
  }
})
