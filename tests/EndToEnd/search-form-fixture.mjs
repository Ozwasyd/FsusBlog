import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { WireHeaders } from '../../src/Contracts/wire.generated.ts'
import { exactText, roleWithExactName } from './role-locators.mjs'

export const generationHeader = WireHeaders.SearchIndexGeneration.toLowerCase()
export const pagesHeader = WireHeaders.SearchIndexPages.toLowerCase()
export const searchWorker = page => page.workers().find(worker => new URL(worker.url()).pathname.includes('/search.worker'))
export const resultLink = (page, title) => roleWithExactName(page.locator('ol.article-list'), 'link', title)
export const noSearchMatches = page => exactText(page, 'No articles match your search.')

export async function submitSearch(page, query) {
  const form = page.locator('form.search-form')
  await form.getByRole('textbox', { name: 'Search articles' }).fill(query)
  await form.getByRole('button', { name: 'Search', exact: true }).click()
  await page.waitForURL(url => url.pathname === '/search' && url.searchParams.get('q') === query)
}

export async function holdRoute(context, match, shouldHold, timeout, timeoutMessage) {
  const arrived = Promise.withResolvers()
  const gate = Promise.withResolvers()
  const handler = async (route, request) => {
    if (shouldHold && !shouldHold(request)) return route.continue()
    arrived.resolve()
    await gate.promise
    // Chromium may have already cancelled the intercepted fetch after worker termination.
    await route.continue().catch(() => {})
  }
  await context.route(match, handler, shouldHold ? undefined : { times: 1 })
  return {
    async reached() {
      const timer = new AbortController()
      try {
        assert(await Promise.race([arrived.promise.then(() => true), delay(timeout, false, { signal: timer.signal })]), timeoutMessage)
      } finally { timer.abort() }
    },
    release: gate.resolve,
    async close() {
      gate.resolve()
      await context.unroute(match, handler)
    },
  }
}
