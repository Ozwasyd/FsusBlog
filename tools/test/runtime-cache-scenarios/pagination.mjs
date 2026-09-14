import fs from 'node:fs'

import {
  exactAssertionResult,
  mapConcurrent,
  produceMeasuredScenarioReceipt
} from '../run-runtime-cache-evidence.mjs'

function paginationInput(identity) {
  const fixture = JSON.parse(fs.readFileSync(identity.fixtureFile, 'utf8'))
  const pagination = fixture.pagination ?? fixture.producerOutputs?.['public-content']?.projection?.pagination
  if (!pagination || pagination.route !== 'article/list/home' || pagination.sort !== 'latest' || pagination.pageSize !== 10) {
    throw new Error('pagination requires the current prepared runtime-cache-pagination projection')
  }
  const expectedPages = [10, 100, 1000]
  const cursors = new Map((pagination.cursors ?? []).map((item) => [item.logicalPage, item.cursor]))
  if (expectedPages.some((page) => typeof cursors.get(page) !== 'string' || cursors.get(page).length === 0)) {
    throw new Error('pagination projection lacks production page 10/100/1000 cursors')
  }
  return { ...pagination, cursors }
}

function route(page, size, parameters) {
  const query = new URLSearchParams(parameters)
  return `/api/binary/article/list/home/${page}/${size}.aeds?${query}`
}

function logicalSpec(input, logicalPage, runId, phase) {
  const cursor = logicalPage === 1 ? null : input.cursors.get(logicalPage)
  return {
    method: 'GET',
    path: route(logicalPage, input.pageSize, {
      sort: input.sort,
      ...(cursor === null ? {} : { cursor }),
      'runtime-cache-evidence': `${runId}-${phase}-page-${logicalPage}`
    }),
    subcaseId: `page-${logicalPage}`,
    parityGroup: `pagination-page-${logicalPage}`,
    headers: {}
  }
}

function cursorlessSpec(input, logicalPage, runId, index) {
  return {
    method: 'GET',
    path: route(logicalPage, input.pageSize, {
      sort: input.sort,
      'runtime-cache-evidence': `${runId}-cursorless-${index + 1}`
    }),
    subcaseId: 'cursorless-deep',
    parityGroup: `pagination-cursorless-${logicalPage}`,
    headers: {}
  }
}

export async function producePaginationReceipt(options) {
  const { scenario, identity } = options
  const input = paginationInput(identity)
  const logicalPages = scenario.requirements.logicalPages

  return produceMeasuredScenarioReceipt(options, {
    warmup: async ({ collect, runId }) => {
      const specs = Array.from({ length: scenario.warmupRequests }, (_, index) => ({
        method: 'GET',
        path: `/api/binary/system/seo?runtime-cache-evidence=${encodeURIComponent(`${runId}-pagination-warmup-${index + 1}`)}`,
        subcaseId: 'page-1',
        parityGroup: 'pagination-warmup',
        headers: {}
      }))
      return mapConcurrent(specs, scenario.concurrency, (spec, index) => collect(spec, index, 'warmup'))
    },
    sample: async ({ collect, runId }) => {
      const logical = []
      for (const [index, page] of logicalPages.entries()) {
        logical.push(await collect(logicalSpec(input, page, runId, 'sample'), index))
      }
      const cursorlessPages = [10, 100, 1000, 1001]
      const cursorless = []
      for (const [index, page] of cursorlessPages.entries()) {
        cursorless.push(await collect(cursorlessSpec(input, page, runId, index), logical.length + index))
      }
      const requests = [...logical, ...cursorless]
      const dbCounts = Object.fromEntries(logical.map((request) => [request.subcaseId, request.dbCommands.length]))
      const constant = new Set(Object.values(dbCounts)).size === 1
      const cursorlessCounts = {
        redis: cursorless.reduce((sum, request) => sum + request.redisCommands.length, 0),
        database: cursorless.reduce((sum, request) => sum + request.dbCommands.length, 0)
      }
      return {
        requests,
        assertionResults: [
          exactAssertionResult(
            'logical-page-command-constant',
            { constant: true, positive: true },
            { constant, positive: Object.values(dbCounts).every((count) => count > 0) },
            logical.find((request) => request.dbCommands.length !== logical[0].dbCommands.length) ?? logical[0]),
          exactAssertionResult(
            'cursorless-deep-zero-commands',
            { redis: 0, database: 0 },
            cursorlessCounts,
            cursorless.find((request) => request.redisCommands.length > 0 || request.dbCommands.length > 0) ?? cursorless[0])
        ],
        parameters: {
          route: '/api/binary/article/list/home/{page}/10.aeds',
          sort: input.sort,
          generation: input.generation,
          articleCount: input.articleCount,
          ownedArticleCount: input.ownedArticleCount,
          logicalPages,
          cursorlessPages
        }
      }
    }
  })
}
